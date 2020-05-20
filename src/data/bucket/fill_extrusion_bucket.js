// @flow

import {FillExtrusionLayoutArray, FillExtrusionCentroidArray} from '../array_types';

import {members as layoutAttributes, centroidAttributes} from './fill_extrusion_attributes';
import SegmentVector from '../segment';
import {ProgramConfigurationSet} from '../program_configuration';
import {TriangleIndexArray} from '../index_array_type';
import EXTENT from '../extent';
import earcut from 'earcut';
import mvt from '@mapbox/vector-tile';
const vectorTileFeatureTypes = mvt.VectorTileFeature.types;
import classifyRings from '../../util/classify_rings';
import assert from 'assert';
const EARCUT_MAX_RINGS = 500;
import {register} from '../../util/web_worker_transfer';
import {hasPattern, addPatternDependencies} from './pattern_bucket_features';
import loadGeometry from '../load_geometry';
import EvaluationParameters from '../../style/evaluation_parameters';
import Point from '@mapbox/point-geometry';
import {number as interpolate} from '../../style-spec/util/interpolate';
import {clamp} from '../../util/util';

import type {CanonicalTileID} from '../../source/tile_id';
import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    IndexedFeature,
    PopulateParameters
} from '../bucket';

import type FillExtrusionStyleLayer from '../../style/style_layer/fill_extrusion_style_layer';
import type Context from '../../gl/context';
import type IndexBuffer from '../../gl/index_buffer';
import type VertexBuffer from '../../gl/vertex_buffer';
import type {FeatureStates} from '../../source/source_state';
import type {ImagePosition} from '../../render/image_atlas';

const FACTOR = Math.pow(2, 13);

function addVertex(vertexArray, x, y, nxRatio, nySign, normalUp, top, e) {
    vertexArray.emplaceBack(
        // a_pos_normal_ed:
        // Encode top and side/up normal using the least significant bits
        (x << 1) + top,
        (y << 1) + normalUp,
        // dxdy is signed, encode quadrant info using the least significant bit
        (Math.floor(nxRatio * FACTOR) << 1) + nySign,
        // edgedistance (used for wrapping patterns around extrusion sides)
        Math.round(e)
    );
}

class ClampedCentroid {
    acc: [number, number];
    clamp: [?number, ?number];
    minIntersection: [number, number];
    maxIntersection: [number, number];
    min: [number, number];
    max: [number, number];

    constructor() {
        this.acc = [0, 0];
        this.clamp = [undefined, undefined];
        this.minIntersection = [2 * EXTENT, 2 * EXTENT];
        this.maxIntersection = [-2 * EXTENT, -2 * EXTENT];
        this.min = [2 * EXTENT, 2 * EXTENT];
        this.max = [-2 * EXTENT, -2 * EXTENT];
    }

    startRing(p: Point) {
        const min = this.min, max = this.max, clamp = this.clamp;
        if (p.x < min[0]) {
            if (p.x <= 0) { clamp[0] = 0; }
            min[0] = p.x;
        }
        if (p.x > max[0]) {
            if (p.x >= EXTENT) { clamp[0] = EXTENT; }
            max[0] = p.x;
        }
        if (p.y < min[1]) {
            if (p.y <= 0) { clamp[1] = 0; }
            min[1] = p.y;
        }
        if (p.y > max[1]) {
            if (p.y >= EXTENT) { clamp[1] = EXTENT; }
            max[1] = p.y;
        }
    }

    _appendComponent(i: 0 | 1, p: Point, prev: Point) {
        const a = i === 0 ? 'x' : 'y';
        const b = i === 0 ? 'y' : 'x';
        const v = p[a];
        const w = p[b];
        const min = this.min, max = this.max, clamp = this.clamp;
        if (clamp[i] === undefined) {
            this.acc[i] += v;
            if (v < min[i]) {
                if (v <= 0) { clamp[i] = 0; }
                min[i] = v;
            } else if (v > max[i]) {
                if (v >= EXTENT) { clamp[i] = EXTENT; }
                max[i] = v;
            }
        }
        let intersection;
        const prevv = prev[a];
        if (clamp[i] !== undefined && (prevv <= 0) !== (v <= 0)) {
            intersection = interpolate(prev[b], w, (0 - prevv) / (v - prevv));
        } else if (clamp[i] !== undefined && (prevv >= EXTENT) !== (v >= EXTENT)) {
            intersection = interpolate(prev[b], w, (EXTENT - prevv) / (v - prevv));
        }
        if (intersection) {
            const j: 0 | 1 = i === 0 ? 1 : 0;
            this.minIntersection[j] = Math.min(intersection, this.minIntersection[j]);
            this.maxIntersection[j] = Math.max(intersection, this.maxIntersection[j]);
        }
    }

    appendEdge(p: Point, prev: Point) {
        this._appendComponent(0, p, prev);
        this._appendComponent(1, p, prev);
    }

    value(i: 0 | 1, count: number): number {
        if (this.clamp[i] != null) { return this.clamp[i]; }
        const v = Math.floor(this.acc[i] / count);
        const j = 1 - i;
        if (this.clamp[j] !== undefined) {
            assert(this.minIntersection[i] < 2 * EXTENT);
            assert(this.maxIntersection[i] > -2 * EXTENT);
            return (this.minIntersection[i] + this.maxIntersection[i]) / 2;
        }
        return v;
    }

    span(i: 0 | 1): number {
        const j: 0 | 1 = i === 0 ? 1 : 0;
        if (this.clamp[j] !== undefined) {
            if (this.clamp[i] !== undefined) return 0;
            return (this.maxIntersection[i] - this.minIntersection[i]);
        }
        return this.clamp[i] === undefined ? this.max[i] - this.min[i] : 0;
    }
}

class FillExtrusionBucket implements Bucket {
    index: number;
    zoom: number;
    overscaling: number;
    layers: Array<FillExtrusionStyleLayer>;
    layerIds: Array<string>;
    stateDependentLayers: Array<FillExtrusionStyleLayer>;
    stateDependentLayerIds: Array<string>;

    layoutVertexArray: FillExtrusionLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    centroidVertexArray: FillExtrusionCentroidArray;
    centroidVertexBuffer: VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    hasPattern: boolean;
    programConfigurations: ProgramConfigurationSet<FillExtrusionStyleLayer>;
    segments: SegmentVector;
    uploaded: boolean;
    features: Array<BucketFeature>;

    constructor(options: BucketParameters<FillExtrusionStyleLayer>) {
        this.zoom = options.zoom;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.hasPattern = false;

        this.layoutVertexArray = new FillExtrusionLayoutArray();
        this.centroidVertexArray = new FillExtrusionCentroidArray();
        this.indexArray = new TriangleIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);

    }

    populate(features: Array<IndexedFeature>, options: PopulateParameters, canonical: CanonicalTileID) {
        this.features = [];
        this.hasPattern = hasPattern('fill-extrusion', this.layers, options);

        for (const {feature, id, index, sourceLayerIndex} of features) {
            const needGeometry = this.layers[0]._featureFilter.needGeometry;
            const evaluationFeature = {type: feature.type,
                id,
                properties: feature.properties,
                geometry: needGeometry ? loadGeometry(feature) : []};

            if (!this.layers[0]._featureFilter.filter(new EvaluationParameters(this.zoom), evaluationFeature, canonical)) continue;

            const patternFeature: BucketFeature = {
                id,
                sourceLayerIndex,
                index,
                geometry: needGeometry ? evaluationFeature.geometry : loadGeometry(feature),
                properties: feature.properties,
                type: feature.type,
                patterns: {}
            };

            if (typeof feature.id !== 'undefined') {
                patternFeature.id = feature.id;
            }

            if (this.hasPattern) {
                this.features.push(addPatternDependencies('fill-extrusion', this.layers, patternFeature, this.zoom, options));
            } else {
                this.addFeature(patternFeature, patternFeature.geometry, index, canonical, {});
            }

            options.featureIndex.insert(feature, patternFeature.geometry, index, sourceLayerIndex, this.index, true);
        }
    }

    addFeatures(options: PopulateParameters, canonical: CanonicalTileID, imagePositions: {[_: string]: ImagePosition}) {
        for (const feature of this.features) {
            const {geometry} = feature;
            this.addFeature(feature, geometry, feature.index, canonical, imagePositions);
        }
    }

    update(states: FeatureStates, vtLayer: VectorTileLayer, imagePositions: {[_: string]: ImagePosition}) {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, imagePositions);
    }

    isEmpty() {
        return this.layoutVertexArray.length === 0;
    }

    uploadPending() {
        return !this.uploaded || this.programConfigurations.needsUpload;
    }

    upload(context: Context) {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            if (this.centroidVertexArray.length > 0) {
                this.centroidVertexBuffer = context.createVertexBuffer(this.centroidVertexArray, centroidAttributes.members);
                assert(this.centroidVertexArray.length === this.layoutVertexArray.length);
            }
            this.indexBuffer = context.createIndexBuffer(this.indexArray);
        }
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    destroy() {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        if (this.centroidVertexBuffer) this.centroidVertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
    }

    addFeature(feature: BucketFeature, geometry: Array<Array<Point>>, index: number, canonical: CanonicalTileID, imagePositions: {[_: string]: ImagePosition}) {
        const appendRepeatedCentroids = (count, x, y, x1, y1) => {
            for (let i = 0; i < count; i++) {
                this.centroidVertexArray.emplaceBack(x, y);
                if (x1 != null && y1 != null) this.centroidVertexArray.emplaceBack(x1, y1);
            }
        };
        const flatRoof = feature.properties && feature.properties.hasOwnProperty('type') && feature.properties.hasOwnProperty('height') &&
            vectorTileFeatureTypes[feature.type] === 'Polygon';

        const centroid = new ClampedCentroid();
        const polyCount = [];

        for (const polygon of classifyRings(geometry, EARCUT_MAX_RINGS)) {
            let numVertices = 0;
            let segment = this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray);

            const isRingOutside = {};
            const polyInfo = {edges: 0, top: 0};
            polyCount.push(polyInfo);

            for (let i = 0; i < polygon.length; i++) {
                const ring = polygon[i];
                if (ring.length === 0) {
                    continue;
                }

                if (isEntirelyOutside(ring)) {
                    isRingOutside[i] = true;
                    continue;
                }
                numVertices += ring.length;

                let edgeDistance = 0;
                if (flatRoof) centroid.startRing(ring[0]);

                for (let p = 0; p < ring.length; p++) {
                    const p1 = ring[p];

                    if (p >= 1) {
                        const p2 = ring[p - 1];

                        if (!isBoundaryEdge(p1, p2)) {
                            if (flatRoof) centroid.appendEdge(p1, p2);
                            if (segment.vertexLength + 4 > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
                                segment = this.segments.prepareSegment(4, this.layoutVertexArray, this.indexArray);
                            }

                            const d = p1.sub(p2)._perp();
                            // Given that nz === 0, encode nx / (abs(nx) + abs(ny)) and signs.
                            // This information is sufficient to reconstruct normal vector in vertex shader.
                            const nxRatio = d.x / (Math.abs(d.x) + Math.abs(d.y));
                            const nySign = d.y > 0 ? 1 : 0;
                            const dist = p2.dist(p1);
                            if (edgeDistance + dist > 32768) edgeDistance = 0;

                            addVertex(this.layoutVertexArray, p1.x, p1.y, nxRatio, nySign, 0, 0, edgeDistance);
                            addVertex(this.layoutVertexArray, p1.x, p1.y, nxRatio, nySign, 0, 1, edgeDistance);

                            edgeDistance += dist;

                            addVertex(this.layoutVertexArray, p2.x, p2.y, nxRatio, nySign, 0, 0, edgeDistance);
                            addVertex(this.layoutVertexArray, p2.x, p2.y, nxRatio, nySign, 0, 1, edgeDistance);

                            const bottomRight = segment.vertexLength;

                            // ┌──────┐
                            // │ 0  1 │ Counter-clockwise winding order.
                            // │      │ Triangle 1: 0 => 2 => 1
                            // │ 2  3 │ Triangle 2: 1 => 2 => 3
                            // └──────┘
                            this.indexArray.emplaceBack(bottomRight, bottomRight + 2, bottomRight + 1);
                            this.indexArray.emplaceBack(bottomRight + 1, bottomRight + 2, bottomRight + 3);

                            segment.vertexLength += 4;
                            segment.primitiveLength += 2;
                            polyInfo.edges++;
                        }
                    }
                }
            }

            if (segment.vertexLength + numVertices > SegmentVector.MAX_VERTEX_ARRAY_LENGTH) {
                segment = this.segments.prepareSegment(numVertices, this.layoutVertexArray, this.indexArray);
            }

            //Only triangulate and draw the area of the feature if it is a polygon
            //Other feature types (e.g. LineString) do not have area, so triangulation is pointless / undefined
            if (vectorTileFeatureTypes[feature.type] !== 'Polygon')
                continue;

            const flattened = [];
            const holeIndices = [];
            const triangleIndex = segment.vertexLength;

            for (let i = 0; i < polygon.length; i++) {
                const ring = polygon[i];
                if (ring.length === 0) {
                    continue;
                }

                if (isRingOutside.hasOwnProperty(i) && isRingOutside[i])
                    continue; // isEntirelyOutside

                if (ring !== polygon[0]) {
                    holeIndices.push(flattened.length / 2);
                }

                for (let i = 0; i < ring.length; i++) {
                    const p = ring[i];

                    addVertex(this.layoutVertexArray, p.x, p.y, 0, 0, 1, 1, 0);

                    flattened.push(p.x);
                    flattened.push(p.y);
                    polyInfo.top++;
                }
            }

            const indices = earcut(flattened, holeIndices);
            assert(indices.length % 3 === 0);

            for (let j = 0; j < indices.length; j += 3) {
                // Counter-clockwise winding order.
                this.indexArray.emplaceBack(
                    triangleIndex + indices[j],
                    triangleIndex + indices[j + 2],
                    triangleIndex + indices[j + 1]);
            }

            segment.primitiveLength += indices.length / 3;
            segment.vertexLength += numVertices;
        }

        if (flatRoof) {
            const count = polyCount.reduce((acc, p) => acc + p.edges, 0);
            if (count > 0) {
                const toMeter = tileToMeter(canonical);
                let xSpan = toMeter * centroid.span(0);
                let ySpan = toMeter * centroid.span(1);
                // When building is split between tiles, we don't cross reference building
                // on both sides to reconcile size but use heuristics based on tile edge
                // intersection length. Encode 10 meters multiplier in 3 bits.
                if (xSpan === 0) { xSpan = ySpan === 0 ? 20 : ySpan * 2.0; }
                if (ySpan === 0) { ySpan = xSpan === 0 ? 20 : xSpan * 2.0; }
                const x = (clamp(centroid.value(0, count), 1, EXTENT - 1) << 3) + Math.min(7, Math.round(xSpan / 10));
                const y = (clamp(centroid.value(1, count), 1, EXTENT - 1) << 3) + Math.min(7, Math.round(ySpan / 10));

                for (const polyInfo of polyCount) {
                    appendRepeatedCentroids(polyInfo.edges * 2, 0, 0, x, y);
                    appendRepeatedCentroids(polyInfo.top, x, y);
                }
            }
        }

        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, imagePositions, canonical);
    }
}

register('FillExtrusionBucket', FillExtrusionBucket, {omit: ['layers', 'features']});

export default FillExtrusionBucket;

function isBoundaryEdge(p1, p2) {
    return (p1.x === p2.x && (p1.x < 0 || p1.x > EXTENT)) ||
        (p1.y === p2.y && (p1.y < 0 || p1.y > EXTENT));
}

// If points are out or on tile border, don't render as it is rendered in
// tile across the boundary.
function isEntirelyOutside(ring) {
    return ring.every(p => p.x <= 0) ||
        ring.every(p => p.x >= EXTENT) ||
        ring.every(p => p.y <= 0) ||
        ring.every(p => p.y >= EXTENT);
}

function tileToMeter(canonical: CanonicalTileID) {
    const circumferenceAtEquator = 40075017;
    const mercatorY = canonical.y / (1 << canonical.z);
    const exp = Math.exp(Math.PI * (1 - 2 * mercatorY));
    // simplify cos(2 * atan(e) - PI/2) from mercator_coordinate.js, remove trigonometrics.
    return circumferenceAtEquator * 2 * exp / (exp * exp + 1) / EXTENT / (1 << canonical.z);
}
