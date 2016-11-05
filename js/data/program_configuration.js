'use strict';

const createVertexArrayType = require('./vertex_array_type');
const util = require('../util/util');
const assert = require('assert');

/**
 * ProgramConfiguration contains the logic for binding style layer properties and tile
 * layer feature data into GL program uniforms and vertex attributes.
 *
 * Non-data-driven property values are bound to shader uniforms. Data-driven property
 * values are bound to vertex attributes. In order to support a uniform GLSL syntax over
 * both, [Mapbox GL Shaders](https://github.com/mapbox/mapbox-gl-shaders) defines a `#pragma`
 * abstraction, which ProgramConfiguration is responsible for implementing. At runtime,
 * it examines the attributes of a particular layer, combines this with fixed knowledge
 * about how layers of the particular type are implemented, and determines which uniforms
 * and vertex attributes will be required. It can then substitute the appropriate text
 * into the shader source code, create and link a program, and bind the uniforms and
 * vertex attributes in preparation for drawing.
 *
 * @private
 */
class ProgramConfiguration {

    constructor() {
        this.attributes = [];
        this.uniforms = [];
        this.interpolationUniforms = [];
        this.vertexPragmas = {};
        this.fragmentPragmas = {};
    }

    static createDynamic(attributes, layer, zoom) {
        const self = new ProgramConfiguration();

        for (const attributeConfig of attributes) {

            const attribute = normalizeAttribute(attributeConfig, layer);
            const inputName = attribute.name;
            assert(inputName.indexOf('a_') === 0);
            const name = inputName.slice(2);
            const multiplier = attribute.multiplier;

            const vert = self.getVertexPragmas(name);
            const frag = self.getFragmentPragmas(name);

            if (layer.isPaintValueFeatureConstant(attribute.paintProperty)) {
                self.uniforms.push(attribute);
                self.addUniform(name, inputName);

            } else if (layer.isPaintValueZoomConstant(attribute.paintProperty)) {
                self.attributes.push(attribute);

                frag.define.push(`varying {precision} {type} ${name};`);
                vert.define.push(`varying {precision} {type} ${name};`);

                vert.define.push(`attribute {precision} {type} ${inputName};`);
                vert.initialize.push(`${name} = ${inputName} / ${multiplier}.0;`);

            } else {
                frag.define.push(`varying {precision} {type} ${name};`);
                vert.define.push(`varying {precision} {type} ${name};`);

                // Pick the index of the first offset to add to the buffers.
                let numStops = 0;
                const zoomLevels = layer.getPaintValueStopZoomLevels(attribute.paintProperty);
                while (numStops < zoomLevels.length && zoomLevels[numStops] < zoom) numStops++;
                const stopOffset = Math.max(0, Math.min(zoomLevels.length - 4, numStops - 2));

                const tName = `u_${name}_t`;

                vert.define.push(`uniform lowp float ${tName};`);
                self.interpolationUniforms.push({
                    name: tName,
                    paintProperty: attribute.paintProperty,
                    stopOffset
                });

                // Find the four closest stops, ideally with two on each side of the zoom level.
                const zoomStops = [];
                for (let s = 0; s < 4; s++) {
                    zoomStops.push(zoomLevels[Math.min(stopOffset + s, zoomLevels.length - 1)]);
                }

                if (attribute.components === 1) {
                    self.attributes.push(util.extend({}, attribute, {
                        components: 4,
                        zoomStops
                    }));
                    vert.define.push(`attribute {precision} vec4 ${inputName};`);
                    vert.initialize.push(`${name} = evaluate_zoom_function_1(${inputName}, ${tName}) / ${multiplier}.0;`);

                } else {
                    const componentNames = [];
                    for (let k = 0; k < 4; k++) {
                        const componentName = inputName + k;

                        self.attributes.push(util.extend({}, attribute, {
                            name: componentName,
                            components: 4,
                            zoomStops: [zoomStops[k]]
                        }));
                        componentNames.push(componentName);
                        vert.define.push(`attribute {precision} {type} ${componentName};`);
                    }
                    vert.initialize.push(`${name} = evaluate_zoom_function_4(${componentNames.join(', ')}, ${tName}) / ${multiplier}.0;`);
                }
            }
        }

        self.cacheKey = JSON.stringify([self.vertexPragmas, self.fragmentPragmas]);

        return self;
    }

    static createStatic(uniformNames) {
        const self = new ProgramConfiguration();

        for (const name of uniformNames) {
            self.addUniform(name, `u_${name}`);
        }
        self.cacheKey = JSON.stringify(self.fragmentPragmas);

        return self;
    }

    addUniform(name, inputName) {
        const frag = this.getFragmentPragmas(name);
        const vert = this.getVertexPragmas(name);

        frag.define.push(`uniform {precision} {type} ${inputName};`);
        vert.define.push(`uniform {precision} {type} ${inputName};`);

        frag.initialize.push(`{precision} {type} ${name} = ${inputName};`);
        vert.initialize.push(`{precision} {type} ${name} = ${inputName};`);
    }

    getFragmentPragmas(name) {
        this.fragmentPragmas[name] = this.fragmentPragmas[name] || {define: [], initialize: []};
        return this.fragmentPragmas[name];
    }

    getVertexPragmas(name) {
        this.vertexPragmas[name] = this.vertexPragmas[name] || {define: [], initialize: []};
        return this.vertexPragmas[name];
    }

    populatePaintArray(layer, paintArray, length, globalProperties, featureProperties) {
        const start = paintArray.length;
        paintArray.resize(length);

        for (const attribute of this.attributes) {
            let value;
            if (attribute.zoomStops) {
                // add one multi-component value like color0, or pack multiple single-component values into a four component attribute
                const values = attribute.zoomStops.map((zoom) => layer.getPaintValue(attribute.paintProperty, util.extend({}, globalProperties, {zoom}), featureProperties));
                value = values.length === 1 ? values[0] : values;
            } else {
                value = layer.getPaintValue(attribute.paintProperty, globalProperties, featureProperties);
            }

            for (let i = start; i < length; i++) {
                const vertex = paintArray.get(i);
                if (attribute.components === 4) {
                    for (let c = 0; c < 4; c++) {
                        vertex[attribute.name + c] = value[c] * attribute.multiplier;
                    }
                } else {
                    vertex[attribute.name] = value * attribute.multiplier;
                }
            }
        }
    }

    paintVertexArrayType() {
        return createVertexArrayType(this.attributes);
    }

    setUniforms(gl, program, layer, globalProperties) {
        for (const uniform of this.uniforms) {
            const value = layer.getPaintValue(uniform.paintProperty, globalProperties);
            if (uniform.components === 4) {
                gl.uniform4fv(program[uniform.name], value);
            } else {
                gl.uniform1f(program[uniform.name], value);
            }
        }
        for (const uniform of this.interpolationUniforms) {
            // stopInterp indicates which stops need to be interpolated.
            // If stopInterp is 3.5 then interpolate half way between stops 3 and 4.
            const stopInterp = layer.getPaintInterpolationT(uniform.paintProperty, globalProperties);
            // We can only store four stop values in the buffers. stopOffset is the number of stops that come
            // before the stops that were added to the buffers.
            gl.uniform1f(program[uniform.name], Math.max(0, Math.min(4, stopInterp - uniform.stopOffset)));
        }
    }
}

function normalizeAttribute(attribute, layer) {
    const specification = layer._paintSpecifications[attribute.paintProperty];
    const isColor = specification.type === 'color';

    attribute = util.extend({}, attribute);
    attribute.components = isColor ? 4 : 1;
    attribute.multiplier = attribute.multiplier || (isColor ? 255 : 1);

    return attribute;
}

module.exports = ProgramConfiguration;
