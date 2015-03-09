'use strict';

var FeatureTree = require('../data/feature_tree');
var Placement = require('../placement/placement');
var vt = require('vector-tile');
var BufferSet = require('../data/buffer/buffer_set');
var createBucket = require('../data/create_bucket');

function getGeometry(feature) {
    return feature.loadGeometry();
}

function getType(feature) {
    return vt.VectorTileFeature.types[feature.type];
}

module.exports = WorkerTile;

function WorkerTile(id, zoom, maxZoom, tileSize, source, overscaling, angle, xhr) {
    this.id = id;
    this.zoom = zoom;
    this.maxZoom = maxZoom;
    this.tileSize = tileSize;
    this.source = source;
    this.overscaling = overscaling;
    this.angle = angle;
    this.xhr = xhr;

    this.stacks = {};

    this.status = 'loading';
}

WorkerTile.prototype.parse = function(data, layers, actor, callback) {

    this.status = 'parsing';

    this.featureTree = new FeatureTree(getGeometry, getType);

    var i, k,
        tile = this,
        layer,
        bucket,
        buffers = new BufferSet(),
        placement = this.placement = new Placement(this.zoom, 4096, this.tileSize),
        buckets = {},
        bucketsInOrder = this.bucketsInOrder = [],
        bucketsBySourceLayer = {};

    placement.reset(this.angle);

    // Map non-ref layers to buckets.
    for (i = 0; i < layers.length; i++) {
        layer = layers[i];

        if (layer.source !== this.source)
            continue;

        if (layer.ref)
            continue;

        var minzoom = layer.minzoom;
        if (minzoom && this.zoom < minzoom && minzoom < this.maxZoom)
            continue;

        var maxzoom = layer.maxzoom;
        if (maxzoom && this.zoom >= maxzoom)
            continue;

        var visibility = layer.layout.visibility;
        if (visibility === 'none')
            continue;

        bucket = createBucket(layer, buffers, placement, this.zoom, this.overscaling);
        bucket.layers = [layer.id];

        buckets[bucket.id] = bucket;
        bucketsInOrder.push(bucket);

        if (data.layers) {
            // vectortile
            var sourceLayer = layer['source-layer'];
            if (!bucketsBySourceLayer[sourceLayer])
                bucketsBySourceLayer[sourceLayer] = {};
            bucketsBySourceLayer[sourceLayer][bucket.id] = bucket;
        } else {
            // geojson tile
            bucketsBySourceLayer[bucket.id] = bucket;
        }
    }

    // Index ref layers.
    for (i = 0; i < layers.length; i++) {
        layer = layers[i];

        if (layer.source !== this.source)
            continue;

        if (!layer.ref)
            continue;

        bucket = buckets[layer.ref];
        if (!bucket)
            continue;

        bucket.layers.push(layer.id);
    }

    // read each layer, and sort its features into buckets
    if (data.layers) {
        // vectortile
        for (k in bucketsBySourceLayer) {
            layer = data.layers[k];
            if (!layer) continue;
            sortLayerIntoBuckets(layer, bucketsBySourceLayer[k]);
        }
    } else {
        // geojson
        sortLayerIntoBuckets(data, bucketsBySourceLayer);
    }

    function sortLayerIntoBuckets(layer, buckets) {
        for (var i = 0; i < layer.length; i++) {
            var feature = layer.feature(i);
            for (var key in buckets) {
                var bucket = buckets[key];
                if (bucket.filter(feature)) {
                    bucket.features.push(feature);
                }
            }
        }
    }

    var prevPlacementBucket;
    var remaining = bucketsInOrder.length;

    /*
     *  The async parsing here is a bit tricky.
     *  Some buckets depend on resources that may need to be loaded async (glyphs).
     *  Some buckets need to be parsed in order (to get placement priorities right).
     *
     *  Dependencies calls are initiated first to get those rolling.
     *  Buckets that don't need to be parsed in order, aren't to save time.
     */

    for (i = 0; i < bucketsInOrder.length; i++) {
        bucket = bucketsInOrder[i];

        // Link buckets that need to be parsed in order
        if (bucket.placement) {
            if (prevPlacementBucket) {
                prevPlacementBucket.next = bucket;
            } else {
                bucket.previousPlaced = true;
            }
            prevPlacementBucket = bucket;
        }

        if (bucket.getDependencies) {
            bucket.getDependencies(this, actor, dependenciesDone(bucket));
        }

        // immediately parse buckets where order doesn't matter and no dependencies
        if (!bucket.placement && !bucket.getDependencies) {
            parseBucket(tile, bucket);
        }
    }

    function dependenciesDone(bucket) {
        return function(err) {
            bucket.dependenciesLoaded = true;
            parseBucket(tile, bucket, err);
        };
    }

    function parseBucket(tile, bucket, skip) {
        if (bucket.getDependencies && !bucket.dependenciesLoaded) return;
        if (bucket.placement && !bucket.previousPlaced) return;

        if (!skip) {
            var now = Date.now();
            if (bucket.features.length) bucket.addFeatures();
            var time = Date.now() - now;
            if (bucket.interactive) {
                for (var i = 0; i < bucket.features.length; i++) {
                    var feature = bucket.features[i];
                    tile.featureTree.insert(feature.bbox(), bucket.layers, feature);
                }
            }
            if (typeof self !== 'undefined') {
                self.bucketStats = self.bucketStats || {_total: 0};
                self.bucketStats._total += time;
                self.bucketStats[bucket.id] = (self.bucketStats[bucket.id] || 0) + time;
            }
        }

        remaining--;

        if (!remaining) {
            done();
            return;
        }

        // try parsing the next bucket, if it is ready
        if (bucket.next) {
            bucket.next.previousPlaced = true;
            parseBucket(tile, bucket.next);
        }
    }

    function done() {

        tile.status = 'done';

        if (tile.redoPlacementAfterDone) {
            var result = tile.redoPlacement(tile.angle).result;
            buffers.glyphVertex = result.buffers.glyphVertex;
            buffers.iconVertex = result.buffers.iconVertex;
            buffers.placementBoxVertex = result.buffers.placementBoxVertex;
        }

        var transferables = [],
            elementGroups = {};

        for (k in buffers) {
            transferables.push(buffers[k].array);
        }

        for (k in buckets) {
            elementGroups[k] = buckets[k].elementGroups;
        }

        callback(null, {
            elementGroups: elementGroups,
            buffers: buffers
        }, transferables);
    }
};

WorkerTile.prototype.redoPlacement = function(angle) {

    if (this.status !== 'done') {
        this.redoPlacementAfterDone = true;
        this.angle = angle;
        return {};
    }

    var buffers = new BufferSet();
    var transferables = [];
    var elementGroups = {};

    //console.time('redo placement');

    var placement = this.placement;
    placement.reset(angle);

    var bucketsInOrder = this.bucketsInOrder;
    for (var i = 0; i < bucketsInOrder.length; i++) {
        var bucket = bucketsInOrder[i];

        if (bucket.type === 'symbol') {
            bucket.placeFeatures(buffers);
            elementGroups[bucket.id] = bucket.elementGroups;
        }
    }


    for (var k in buffers) {
        transferables.push(buffers[k].array);
    }

    //console.timeEnd('redo placement');

    return {
        result: {
            elementGroups: elementGroups,
            buffers: buffers
        },
        transferables: transferables
    };

};
