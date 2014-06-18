'use strict';

var Source = require('./source.js');
var GeoJSONTile = require('./geojsontile.js');

var GeoJSONSource = module.exports = function(geojson) {
    this.tiles = {};
    this.alltiles = {};
    this.enabled = true;

    this.zooms = [1, 5, 9, 13];
    this.minTileZoom = this.zooms[0];
    this.maxTileZoom = this.zooms[this.zooms.length - 1];

    this.loadNewTiles = true;
    this.tileJSON = {
        minZoom: 1,
        maxZoom: 13
    };

    this.geojson = geojson;
};

GeoJSONSource.prototype = Object.create(Source.prototype);

GeoJSONSource.prototype.onAdd = function(map) {
    this.map = map;
    this.painter = map.painter;
    this.updateGeoJSON();
};

GeoJSONSource.prototype.updateGeoJSON = function() {
    this.map.dispatcher.send('parse geojson', {
        geojson: this.geojson,
        zooms: this.zooms,
        tileSize: 512,
        source: this.id
    });
};

GeoJSONSource.prototype._addTile = function(id) {
    var tile = this.alltiles[id];
    if (tile) {
        tile._load();
        this.tiles[id] = tile;
        this.fire('tile.add', {tile: tile});
    }
    return tile || {};
};

GeoJSONSource.prototype._coveringZoomLevel = function(zoom) {
    for (var i = this.zooms.length - 1; i >= 0; i--) {
        if (this.zooms[i] <= zoom) {
            var z = this.zooms[i];
            return z;
        }
    }
    return 0;
};

GeoJSONSource.prototype.addTileFromWorker = function(params) {
    this.alltiles[params.id] = new GeoJSONTile(params.id, this, params);
};
