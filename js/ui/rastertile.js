'use strict';

var Tile = require('./tile.js');

module.exports = RasterTile;
function RasterTile(source, url, zoom, callback) {
    this.loaded = false;
    this.url = url;
    this.source = source;
    this.map = source.map;
    this._load();
    this.callback = callback;
    this.uses = 1;

    // Todo finish figuring out what raster buckets are
    this.buckets = {};
    this.info = { raster: true };
    var sheetBuckets = this.map.style.stylesheet.buckets;
    for (var b in sheetBuckets) {
        var sourceid = sheetBuckets[b].filter && sheetBuckets[b].filter.source;
        if (source.id === sourceid) {
            this.buckets[b] = this;
        }
    }
    // work around painter using bucket.indices to check if bucket has data
    this.indices = {};
}

RasterTile.prototype = Object.create(Tile);

RasterTile.prototype._load = function() {
    this.img = new Image();
    this.img.crossOrigin = 'Anonymous';
    this.img.src = this.url;
    this.img.onload = this.onTileLoad.bind(this);
};

RasterTile.prototype.onTileLoad = function() {
    // start texture upload
    this.bind(this.map.painter.gl);

    this.loaded = true;
    this.callback();
};

RasterTile.prototype.abort = function() {
    this.aborted = true;
    this.img.src = '';
    delete this.img;
};

RasterTile.prototype.bind = function(gl) {
    if (!this.texture) {
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.img);
        gl.generateMipmap(gl.TEXTURE_2D);
    } else {
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
    }
};

RasterTile.prototype.remove = function() {
    if (this.texture) this.map.painter.gl.deleteTexture(this.texture);
    delete this.map;
};

RasterTile.prototype.featuresAt = function(pos, params, callback) {
    // noop
    callback(null, []);
};
