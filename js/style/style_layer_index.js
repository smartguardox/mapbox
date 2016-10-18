'use strict';

const StyleLayer = require('./style_layer');
const featureFilter = require('feature-filter');

class StyleLayerIndex {
    constructor(layers) {
        this.families = [];
        if (layers) {
            this.replace(layers);
        }
    }

    replace(layers) {
        this._layers = {};
        this._order = [];
        this.update(layers);
    }

    _updateLayer(layer) {
        const refLayer = layer.ref && this._layers[layer.ref];

        let styleLayer = this._layers[layer.id];
        if (styleLayer) {
            styleLayer.set(layer, refLayer);
        } else {
            styleLayer = this._layers[layer.id] = StyleLayer.create(layer, refLayer);
        }

        styleLayer.updatePaintTransitions({}, {transition: false});
        styleLayer.filter = featureFilter(styleLayer.filter);
    }

    update(layers) {
        for (const layer of layers) {
            if (!this._layers[layer.id]) {
                this._order.push(layer.id);
            }
        }

        // Update ref parents
        for (const layer of layers) {
            if (!layer.ref) this._updateLayer(layer);
        }

        // Update ref children
        for (const layer of layers) {
            if (layer.ref) this._updateLayer(layer);
        }

        this.families = [];
        const byParent = {};

        for (const id of this._order) {
            const layer = this._layers[id];
            const parent = layer.ref ? this._layers[layer.ref] : layer;

            if (parent.layout && parent.layout.visibility === 'none') {
                continue;
            }

            let family = byParent[parent.id];
            if (!family) {
                family = [];
                this.families.push(family);
                byParent[parent.id] = family;
            }

            if (layer.ref) {
                family.push(layer);
            } else {
                family.unshift(layer);
            }
        }
    }
}

module.exports = StyleLayerIndex;
