# Low-Level Map Renderer (WebGL)

A WebGL implementation of a vector tile client.

## Setup

```
git clone git@github.com:mapbox/fontserver.git
cd fontserver
git clone -b gl git@github.com:mapbox/llmr.git html
npm install
node server.js
```

## Flow

1. MapBox vector tiles coming from `http://api.tiles.mapbox.com/v3/mapbox.mapbox-streets-v4/`
2. tessellation server parses protocol buffer, tessellates polygons, generates
   tessellated data, serves as protocol buffers again
3. This project consumes those processed tiles and provides a map view.

## Recommended Reading

- **TYPE**
- [glyphy](https://code.google.com/p/glyphy/)
- [freetype-gl](https://code.google.com/p/freetype-gl/)
- [distance fields](http://bytewrangler.blogspot.com/2011/10/signed-distance-fields.html)
- [map labelling](http://i11www.iti.uni-karlsruhe.de/~awolff/map-labeling/bibliography/maplab_date.html)
- **ANTI-ALIASING**
- [aacourse](http://iryoku.com/aacourse/)
- [Feature Detection](http://www.browserleaks.com/webgl)

## Includes

- [gl-matrix](https://github.com/toji/gl-matrix)
- [underscore.js](http://underscorejs.org/)
- [domready](https://github.com/ded/domready)

## Performance

- [Graphics Pipeline Performance](http://http.developer.nvidia.com/GPUGems/gpugems_ch28.html)
- [Debugging and Optimizing WebGL applications](https://docs.google.com/presentation/d/12AGAUmElB0oOBgbEEBfhABkIMCL3CUX7kdAPLuwZ964)
