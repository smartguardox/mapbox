importScripts('/gl/js/actor.js',
              '/gl/js/protobuf.js',
              '/gl/js/vectortile.js',
              '/gl/js/util.js',
              '/gl/js/fillbuffer.js',
              '/gl/js/vertexbuffer.js',
              '/gl/js/glyphvertexbuffer.js',
              '/gl/js/geometry.js');

var actor = new Actor(self, self);

// Debug
// if (typeof console === 'undefined') {
    console = {};
    console.log = console.warn = function() {
        postMessage({ type: 'debug message', data: [].slice.call(arguments) });
    };
// }

if (typeof alert === 'undefined') {
    alert = function() {
        postMessage({ type: 'alert message', data: [].slice.call(arguments) });
    };
}


// Stores the style information.
var style = {};

// Stores tiles that are currently loading.
var loading = {};


/*
 * Updates the style to use for this map.
 *
 * @param {Style} data
 */
self['set style'] = function(data) {
    style = data;
};


/*
 * Load and parse a tile at `url`, and call `callback` with
 * (err, response)
 *
 * @param {string} url
 * @param {function} callback
 */
self['load tile'] = function(url, callback) {
    loading[url] = loadBuffer(url, function(err, buffer) {
        delete loading[url];
        if (err) {
            callback(err);
        } else {
            parseTile(buffer, callback);
        }
    });
};

/*
 * Abort the request keyed under `url`
 *
 * @param {string} url
 */
self['abort tile'] = function(url) {
    if (loading[url]) {
        loading[url].abort();
        delete loading[url];
    }
};

/*
 * Request a resources as an arraybuffer
 *
 * @param {string} url
 * @param {function} callback
 */
function loadBuffer(url, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = function(e) {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
            callback(null, xhr.response);
        } else {
            callback(xhr.statusText);
        }
    };
    xhr.send();
    return xhr;
}

/*
 * Sorts features in a layer into different buckets, according to the maping
 *
 * Layers in vector tiles contain many different features, and feature types,
 * e.g. the landuse layer has parks, industrial buildings, forests, playgrounds
 * etc. However, when styling, we need to separate these features so that we can
 * render them separately with different styles.
 *
 * @param {VectorTileLayer} layer
 * @param {Mapping} mapping
 */
function sortFeaturesIntoBuckets(layer, mapping) {
    var buckets = {};
    for (var key in mapping.sort) {
        buckets[key] = [];
    }

    for (var i = 0; i < layer.length; i++) {
        var feature = layer.feature(i);
        for (key in mapping.sort) {
            if (mapping.sort[key] === true ||
                mapping.sort[key].indexOf(feature[mapping.field]) >= 0) {
                buckets[key].push(feature);
                break;
            }
        }
    }

    return buckets;
}

function parseBucket(features, info, faces, layer, geometry, callback) {
    // Remember starting indices of the geometry buffers.
    var bucket = {
        buffer: geometry.bufferIndex,
        vertexIndex: geometry.vertex.index,
        fillIndex: geometry.fill.index
    };

    if (info.type == "text") {
        parseTextBucket(features, bucket, info, faces, layer, geometry, done);
    } else if (info.type == "point" && info.marker) {
        parseMarkerBucket(features, bucket, info, faces, layer, geometry, done);
    } else {
        parseShapeBucket(features, bucket, info, faces, layer, geometry, done);
    }

    function done() {
        bucket.bufferEnd = geometry.bufferIndex;
        bucket.vertexIndexEnd = geometry.vertex.index;
        bucket.fillIndexEnd = geometry.fill.index;
        callback(bucket);
    }
}

function parseTextBucket(features, bucket, info, faces, layer, geometry, callback) {
    // TODO: currently hardcoded to use the first font stack.
    // Get the list of shaped labels for this font stack.
    var stack = Object.keys(layer.shaping)[0];
    var shapingDB = layer.shaping[stack];
    if (!shapingDB) return callback();

    var glyphVertex = geometry.glyph;
    // console.warn(shapingDB);

    bucket.glyphVertexIndex = glyphVertex.index;

    for (var i = 0; i < features.length; i++) {
        var feature = features[i];
        var text = feature[info.field];
        if (!text) continue;
        var shaping = shapingDB[text];

        // Add the label for every line
        var lines = feature.loadGeometry();
        for (var j = 0; j < lines.length; j++) {
            var line = lines[j];

            // Find the index of the longest segment in the line.
            var segment = null;
            var length = 0;
            for (var k = 1; k < line.length; k++) {
                var dist = distance_squared(line[k - 1], line[k]);
                if (dist > length) {
                    length = dist;
                    segment = k;
                }
            }

            var angle = 0;
            var anchor = line[0];

            // If there are line segments at all (and this is not just a point)
            // now find the center of that line segment and define at as the
            // center point of the label. For that line segment, we can now
            // compute the angle of the label (and optionally invert it if the
            // line is flipped.
            if (segment) {
                var a = line[segment - 1], b = line[segment];
                anchor = line_center(a, b);

                // Clamp to -90/+90 degrees
                angle = -Math.atan2(b.x - a.x, b.y - a.y) + Math.PI / 2;
                angle = clamp_horizontal(angle);
            }

            // Compute the transformation matrix.
            var sin = Math.sin(angle), cos = Math.cos(angle);
            var matrix = { a: cos, b: -sin, c: sin, d: cos };

            addText(faces, shaping, anchor, 'center', matrix, angle, glyphVertex);
        }
    }

    // Remember the glyph
    bucket.glyphVertexIndexEnd = glyphVertex.index;

    callback();
}


function addText(faces, shaping, anchor, alignment, matrix, angle, glyphVertex) {
    var advance = measureText(faces, shaping);

    // TODO: figure out correct ascender height.
    var origin = { x: 0, y: -17 };

    // horizontal alignment
    if (alignment == 'center') {
        origin.x -= advance / 2;
    } else if (alignment == 'right') {
        origin.x -= advance;
    }


    var scale = 1;
    var buffer = 3;
    for (var i = 0; i < shaping.length; i++) {
        var shape = shaping[i];
        var face = faces[shape.face];
        var glyph = face.glyphs[shape.glyph];
        var rect = face.rects[shape.glyph];

        if (!glyph) continue;

        var width = glyph.width;
        var height = glyph.height;

        if (width > 0 && height > 0 && rect) {
            width += buffer * 2;
            height += buffer * 2;

            // Increase to next number divisible by 4, but at least 1.
            // This is so we can scale down the texture coordinates and pack them
            // into 2 bytes rather than 4 bytes.
            width += (4 - width % 4);
            height += (4 - height % 4);

            var x1 = origin.x + (shape.x + glyph.left - buffer) * scale;
            var y1 = origin.y + (shape.y - glyph.top - buffer) * scale;

            var x2 = x1 + width * scale;
            var y2 = y1 + height * scale;

            var tl = vectorMul(matrix, { x: x1, y: y1 });
            var tr = vectorMul(matrix, { x: x2, y: y1 });
            var bl = vectorMul(matrix, { x: x1, y: y2 });
            var br = vectorMul(matrix, { x: x2, y: y2 });

            var texX = rect.x;
            var texY = rect.y;

            // first triangle
            glyphVertex.add(anchor.x, anchor.y, tl.x, tl.y, texX, texY, angle);
            glyphVertex.add(anchor.x, anchor.y, tr.x, tr.y, texX + width, texY, angle);
            glyphVertex.add(anchor.x, anchor.y, bl.x, bl.y, texX, texY + height, angle);

            // second triangle
            glyphVertex.add(anchor.x, anchor.y, tr.x, tr.y, texX + width, texY, angle);
            glyphVertex.add(anchor.x, anchor.y, bl.x, bl.y, texX, texY + height, angle);
            glyphVertex.add(anchor.x, anchor.y, br.x, br.y, texX + width, texY + height, angle);
        }

        // pos.x += glyph.advance * scale;
    }
}



function measureText(faces, shaping) {
    var advance = 0;

    // TODO: advance is not calculated correctly. we should instead use the
    // bounding box of the glyph placement.
    for (var i = 0; i < shaping.length; i++) {
        var shape = shaping[i];
        var glyph = faces[shape.face].glyphs[shape.glyph];
        advance += glyph.advance;
    }

    return advance;
}



function parseMarkerBucket(features, bucket, info, faces, layer, geometry, callback) {
    var spacing = info.spacing || 100;

    // Add all the features to the geometry
    for (var i = 0; i < features.length; i++) {
        var feature = features[i];
        var lines = feature.loadGeometry();
        for (var j = 0; j < lines.length; j++) {
            geometry.addMarkers(lines[j], spacing);
        }
    }

    callback();
}

function parseShapeBucket(features, bucket, info, faces, layer, geometry, callback) {
    // Add all the features to the geometry
    for (var i = 0; i < features.length; i++) {
        var feature = features[i];
        var lines = feature.loadGeometry();
        for (var j = 0; j < lines.length; j++) {
            geometry.addLine(lines[j], info.join, info.cap, info.miterLimit, info.roundLimit);
        }
    }

    callback();
}

/*
 * Given tile data, parse raw vertices and data, create a vector
 * tile and parse it into ready-to-render vertices.
 *
 * @param {object} data
 * @param {function} respond
 */
function parseTile(data, callback) {
    var tile = new VectorTile(new Protobuf(new Uint8Array(data)));
    var layers = {};
    var geometry = new Geometry();

    var mappings = style.mapping;

    actor.send('add glyphs', tile.faces, function(err, rects) {
        // Merge the rectangles of the glyph positions into the face object
        for (var name in rects) {
            tile.faces[name].rects = rects[name];
        }

        async_each(mappings, function(mapping, callback) {
            var layer = tile.layers[mapping.layer];
            if (!layer) return callback();

            var buckets = sortFeaturesIntoBuckets(layer, mapping);

            // Build an index of font faces used in this layer.
            var face_index = [];
            for (var i = 0; i < layer.faces.length; i++) {
                face_index[i] = tile.faces[layer.faces[i]];
            }

            // All features are sorted into buckets now. Add them to the geometry
            // object and remember the position/length
            async_each(Object.keys(buckets), function(key, callback) {
                var features = buckets[key];
                var info = style.buckets[key];
                if (!info) {
                    alert("missing bucket information for bucket " + key);
                    return callback();
                }

                parseBucket(features, info, face_index, layer, geometry, function(bucket) {
                    layers[key] = bucket;
                    callback();
                });
            }, callback);
        }, function parseTileComplete() {
            // Collect all buffers to mark them as transferable object.
            var buffers = [ geometry.glyph.array ];
            for (var l = 0; l < geometry.buffers.length; l++) {
                buffers.push(geometry.buffers[l].fill.array, geometry.buffers[l].vertex.array);
            }

            callback(null, {
                geometry: geometry,
                layers: layers
            }, buffers);
        });
    });
}
