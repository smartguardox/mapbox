import fs from 'fs';
import assert from 'assert';
import spec from '../src/style-spec/reference/latest';
import {supportsPropertyExpression, supportsZoomExpression} from '../src/style-spec/util/properties';

function alias(from, to) {
    return `/**
 * @deprecated Use \`${to}\` instead.
 */
export type ${from} = ${to};`;
}

function tsEnum(values) {
    if (Array.isArray(values)) {
        return values.map(v => JSON.stringify(v)).join(' | ');
    } else {
        return Object.keys(values).map(v => JSON.stringify(v)).join(' | ');
    }
}

function tsType(property) {
    if (typeof property.type === 'function') {
        return property.type();
    }

    const baseType = (() => {
        switch (property.type) {
        case 'never':
        case 'string':
        case 'number':
        case 'boolean':
            return property.type;
        case 'enum':
            return tsEnum(property.values);
        case 'array':
            if (property.value === 'light-3d') {
                return 'Array<LightsSpecification>';
            }
            // eslint-disable-next-line no-case-declarations
            const elementType = tsType(typeof property.value === 'string' ? {type: property.value, values: property.values} : property.value);
            if (property.length) {
                return `[${Array(property.length).fill(elementType).join(', ')}]`;
            } else {
                return `Array<${elementType}>`;
            }
        case '$root':
            return 'StyleSpecification';
        case '*':
            return 'unknown';
        default:
            return `${property.type.slice(0, 1).toUpperCase()}${property.type.slice(1)}Specification`;
        }
    })();

    if (supportsPropertyExpression(property)) {
        return `DataDrivenPropertyValueSpecification<${baseType}>`;
    } else if (supportsZoomExpression(property)) {
        return `PropertyValueSpecification<${baseType}>`;
    } else if (property.expression) {
        return `ExpressionSpecification`;
    } else {
        return baseType;
    }
}

function tsProperty(key, property) {
    assert(property, `Property not found in the style-specification for ${key}`);
    if (key === '*') {
        return `[_: string]: ${tsType(property)}`;
    } else {
        return `"${key}"${property.required ? '' : '?'}: ${tsType(property)}${property['optional'] ? ' | null | undefined' : ''}`;
    }
}

function tsObjectDeclaration(key, properties) {
    assert(properties, `Properties not found in the style-specification for ${key}`);
    return `export type ${key} = ${tsObject(properties, '')}`;
}

function tsObject(properties, indent) {
    return `{
${Object.keys(properties)
        .map(k => {
            const property = `    ${indent}${tsProperty(k, properties[k])}`;
            if (properties[k].transition) {
                const propertyTransition = `    ${indent}"${k}-transition"?: TransitionSpecification`;
                return [property, propertyTransition].join(',\n');
            } else {
                return property;
            }
        })
        .join(',\n')}
${indent}}`;
}

function tsSourceTypeName(key) {
    return key.replace(/source_(.)(.*)/, (_, _1, _2) => `${_1.toUpperCase()}${_2}Source`)
        .replace(/_dem/, 'DEM')
        .replace(/_array/, 'Array')
        .replace(/Geojson/, 'GeoJSON');
}

function tsSourceSpecificationTypeName(key) {
    return tsSourceTypeName(key).concat('Specification');
}

function tsLightTypeName(key) {
    return key.split('-').map(k => k.replace(/(.)(.*)/, (_, _1, _2) => `${_1.toUpperCase()}${_2}`)).concat('LightSpecification').join('');
}

function tsLayerName(key) {
    return key.split('-').map(k => k.replace(/(.)(.*)/, (_, _1, _2) => `${_1.toUpperCase()}${_2}`)).join('');
}

function tsLayerTypeName(key) {
    return tsLayerName(key).concat('Layer');
}

function tsLayerSpecificationTypeName(key) {
    return tsLayerTypeName(key).concat('Specification');
}

function tsLayer(key) {
    const layer = structuredClone(spec.layer as any);

    layer.type = {
        type: 'enum',
        values: [key],
        required: true
    };

    delete layer.ref;
    delete layer['paint.*'];

    if (spec[`paint_${key}`]) {
        layer.paint.type = () => {
            return tsObject(spec[`paint_${key}`], '    ');
        };
    } else {
        delete layer.paint;
    }

    if (spec[`layout_${key}`]) {
        layer.layout.type = () => {
            return tsObject(spec[`layout_${key}`], '    ');
        };
    } else {
        delete layer.layout;
    }

    if (key === 'background' || key === 'sky' || key === 'slot') {
        layer.source = {type: 'never'};
        layer['source-layer'] = {type: 'never'};
        layer.filter = {type: 'never'};
    } else {
        layer.source.required = true;
    }

    if (key === 'slot') {
        layer.minzoom = {type: 'never'};
        layer.maxzoom = {type: 'never'};
    }

    if (!spec[`layout_${key}`]) {
        layer.layout = {type: 'never'};
    }

    if (!spec[`paint_${key}`]) {
        layer.paint = {type: 'never'};
    }

    const definitions = [
        tsObjectDeclaration(tsLayerSpecificationTypeName(key), layer)
    ];

    if (spec[`layout_${key}`]) {
        definitions.push(alias(`${tsLayerName(key)}Layout`, `${tsLayerSpecificationTypeName(key)}['layout']`));
    }

    if (spec[`paint_${key}`]) {
        definitions.push(alias(`${tsLayerName(key)}Paint`, `${tsLayerSpecificationTypeName(key)}['paint']`));
    }

    return definitions.join('\n\n');
}

function tsLight(key) {
    const light = spec['light-3d'] as any;

    light.type = {
        type: 'enum',
        values: [key],
        required: true
    };

    light.properties.type = () => {
        return tsObject(spec[`properties_light_${key}`], '    ');
    };

    return tsObjectDeclaration(tsLightTypeName(key), light);
}

const lightTypes = Object.keys(spec['light-3d'].type.values);

const layerTypes = Object.keys(spec.layer.type.values);

fs.writeFileSync('src/style-spec/types.ts', `// Generated code; do not edit. Edit build/generate-typed-style-spec.ts instead.
/* eslint-disable */

export type ColorSpecification = string;

export type FormattedSpecification = string;

export type ResolvedImageSpecification = string;

export type PromoteIdSpecification = {[_: string]: string} | string;

export type FilterSpecification =
    | ['has', string]
    | ['!has', string]
    | ['==', string, string | number | boolean]
    | ['!=', string, string | number | boolean]
    | ['>', string, string | number | boolean]
    | ['>=', string, string | number | boolean]
    | ['<', string, string | number | boolean]
    | ['<=', string, string | number | boolean]
    | Array<string | FilterSpecification>; // Can't type in, !in, all, any, none -- https://github.com/facebook/flow/issues/2443

export type TransitionSpecification = {
    duration?: number,
    delay?: number
};

// Note: doesn't capture interpolatable vs. non-interpolatable types.

export type CameraFunctionSpecification<T> =
    | { type: 'exponential', stops: Array<[number, T]> }
    | { type: 'interval',    stops: Array<[number, T]> };

export type SourceFunctionSpecification<T> =
    | { type: 'exponential', stops: Array<[number, T]>, property: string, default?: T }
    | { type: 'interval',    stops: Array<[number, T]>, property: string, default?: T }
    | { type: 'categorical', stops: Array<[string | number | boolean, T]>, property: string, default?: T }
    | { type: 'identity', property: string, default?: T };

export type CompositeFunctionSpecification<T> =
    | { type: 'exponential', stops: Array<[{zoom: number, value: number}, T]>, property: string, default?: T }
    | { type: 'interval',    stops: Array<[{zoom: number, value: number}, T]>, property: string, default?: T }
    | { type: 'categorical', stops: Array<[{zoom: number, value: string | number | boolean}, T]>, property: string, default?: T };

export type ExpressionSpecification = [string, ...any[]];

export type PropertyValueSpecification<T> =
    | T
    | CameraFunctionSpecification<T>
    | ExpressionSpecification;

export type DataDrivenPropertyValueSpecification<T> =
    | T
    | CameraFunctionSpecification<T>
    | SourceFunctionSpecification<T>
    | CompositeFunctionSpecification<T>
    | ExpressionSpecification;

${tsObjectDeclaration('StyleSpecification', spec.$root)}

${tsObjectDeclaration('SourcesSpecification', spec.sources)}

${tsObjectDeclaration('ModelsSpecification', spec.models)}

${tsObjectDeclaration('LightSpecification', spec.light)}

${tsObjectDeclaration('TerrainSpecification', spec.terrain)}

${tsObjectDeclaration('FogSpecification', spec.fog)}

${tsObjectDeclaration('CameraSpecification', spec.camera)}

${tsObjectDeclaration('ColorThemeSpecification', spec.colorTheme)}

${tsObjectDeclaration('ProjectionSpecification', spec.projection)}

${tsObjectDeclaration('ImportSpecification', spec.import)}

${tsObjectDeclaration('ConfigSpecification', spec.config)}

${tsObjectDeclaration('SchemaSpecification', spec.schema)}

${tsObjectDeclaration('OptionSpecification', spec.option)}

${spec.source.map(key => tsObjectDeclaration(tsSourceSpecificationTypeName(key), spec[key])).join('\n\n')}

export type SourceSpecification =
${spec.source.map(key => `    | ${tsSourceSpecificationTypeName(key)}`).join('\n')}

export type ModelSpecification = ${tsType(spec.model)};

${lightTypes.map(key => tsLight(key)).join('\n\n')}

export type LightsSpecification =
${lightTypes.map(key => `    | ${tsLightTypeName(key)}`).join('\n')};

${layerTypes.map(key => tsLayer(key)).join('\n\n')}

export type LayerSpecification =
${layerTypes.map(key => `    | ${tsLayerSpecificationTypeName(key)}`).join('\n')};

// Aliases for easier migration from @types/mapbox-gl

export type Layer = Pick<
    LayerSpecification,
    | "id"
    | "type"
    | "source"
    | "source-layer"
    | "slot"
    | "filter"
    | "layout"
    | "paint"
    | "minzoom"
    | "maxzoom"
    | "metadata"
>;

${alias('Style', 'StyleSpecification')}

${alias('AnyLayer', 'LayerSpecification')}

${layerTypes.map(key => alias(tsLayerTypeName(key), tsLayerSpecificationTypeName(key))).join('\n\n')}

/**
 * @deprecated
 */
export type AnyLayout =
${layerTypes.filter(key => !!spec[`layout_${key}`]).map(key => `    | ${tsLayerName(key)}Layout`).join('\n')};

/**
 * @deprecated
 */
export type AnyPaint =
${layerTypes.filter(key => !!spec[`paint_${key}`]).map(key => `    | ${tsLayerName(key)}Paint`).join('\n')};

${alias('Expression', 'ExpressionSpecification')}

${alias('Transition', 'TransitionSpecification')}

${alias('Source', 'SourceSpecification')}

${alias('AnySourceData', 'SourceSpecification')}

${alias('Sources', 'SourcesSpecification')}

${alias('Projection', 'ProjectionSpecification')}
`);
