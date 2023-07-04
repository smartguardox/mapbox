// @flow

import {FillExtrusionGroundLayoutArray, FillExtrusionLayoutArray, FillExtrusionExtArray, FillExtrusionCentroidArray, FillExtrusionHiddenByLandmarkArray, PosArray} from '../array_types.js';

import {members as layoutAttributes, fillExtrusionGroundAttributes, centroidAttributes, fillExtrusionAttributesExt, hiddenByLandmarkAttributes} from './fill_extrusion_attributes.js';
import SegmentVector from '../segment.js';
import {ProgramConfigurationSet} from '../program_configuration.js';
import {TriangleIndexArray} from '../index_array_type.js';
import EXTENT from '../extent.js';
import earcut from 'earcut';
import {VectorTileFeature} from '@mapbox/vector-tile';
import type {Feature} from "../../style-spec/expression";
const vectorTileFeatureTypes = VectorTileFeature.types;
import classifyRings from '../../util/classify_rings.js';
import assert from 'assert';
const EARCUT_MAX_RINGS = 500;
import {register} from '../../util/web_worker_transfer.js';
import {hasPattern, addPatternDependencies} from './pattern_bucket_features.js';
import loadGeometry from '../load_geometry.js';
import toEvaluationFeature from '../evaluation_feature.js';
import EvaluationParameters from '../../style/evaluation_parameters.js';
import Point from '@mapbox/point-geometry';
import {number as interpolate} from '../../style-spec/util/interpolate.js';
import {lngFromMercatorX, latFromMercatorY, mercatorYfromLat, tileToMeter} from '../../geo/mercator_coordinate.js';
import {subdividePolygons} from '../../util/polygon_clipping.js';
import {ReplacementSource, regionsEquals, footprintTrianglesIntersect} from '../../../3d-style/source/replacement_source.js';
import {clamp} from '../../util/util.js';
import type {ClippedPolygon} from '../../util/polygon_clipping.js';
import type {Vec3} from 'gl-matrix';
import type {CanonicalTileID, OverscaledTileID} from '../../source/tile_id.js';
import type {
    Bucket,
    BucketParameters,
    BucketFeature,
    IndexedFeature,
    PopulateParameters
} from '../bucket.js';
import {earthRadius} from '../../geo/lng_lat.js';

import type FillExtrusionStyleLayer from '../../style/style_layer/fill_extrusion_style_layer.js';
import type Context from '../../gl/context.js';
import type IndexBuffer from '../../gl/index_buffer.js';
import type VertexBuffer from '../../gl/vertex_buffer.js';
import type {FeatureStates} from '../../source/source_state.js';
import type {SpritePositions} from '../../util/image.js';
import type {ProjectionSpecification} from '../../style-spec/types.js';
import type {TileTransform} from '../../geo/projection/tile_transform.js';
import type {IVectorTileLayer} from '@mapbox/vector-tile';

const FACTOR = Math.pow(2, 13);
const TANGENT_CUTOFF = 4;

// Also declared in _prelude_terrain.vertex.glsl
// Used to scale most likely elevation values to fit well in an uint16
// (Elevation of Dead Sea + ELEVATION_OFFSET) * ELEVATION_SCALE is roughly 0
// (Height of mt everest + ELEVATION_OFFSET) * ELEVATION_SCALE is roughly 64k
export const ELEVATION_SCALE = 7.0;
export const ELEVATION_OFFSET = 450;

function addVertex(vertexArray: FillExtrusionLayoutArray, x: number, y: number, nxRatio: number, nySign: number, normalUp: number, top: number, e: number) {
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

function addGroundVertex(vertexArray: FillExtrusionGroundLayoutArray, p: Point, q: Point, start: number, bottom: number, angle: number) {
    vertexArray.emplaceBack(
        p.x,
        p.y,
        (q.x << 1) + start,
        (q.y << 1) + bottom,
        angle
    );
}

function addGlobeExtVertex(vertexArray: FillExtrusionExtArray, pos: {x: number, y: number, z: number}, normal: Vec3) {
    const encode = 1 << 14;
    vertexArray.emplaceBack(
        pos.x, pos.y, pos.z,
        normal[0] * encode, normal[1] * encode, normal[2] * encode);
}

class FootprintSegment {
    vertexOffset: number;
    vertexCount: number;
    indexOffset: number;
    indexCount: number;

    constructor() {
        this.vertexOffset = 0;
        this.vertexCount = 0;
        this.indexOffset = 0;
        this.indexCount = 0;
    }
}

// Stores centroid buffer content (one entry per feature as opposite to one entry per
// vertex in the buffer). This information is used to do conflation vs 3d model layers.
// PartData and BorderCentroidData are split because PartData is stored for every
// bucket feature and BorderCentroidData only for features that intersect border.
export class PartData {
    centroidXY: Point;
    vertexArrayOffset: number;
    vertexCount: number;
    groundVertexArrayOffset: number;
    groundVertexCount: number;
    flags: number;
    footprintSegIdx: number;
    footprintSegLen: number;
    min: Point;
    max: Point;

    static hiddenCentroid: Point = new Point(0, 1); // eslint-disable-line no-restricted-syntax
    static HiddenByReplacement: number = 0x80000000; // eslint-disable-line no-restricted-syntax

    constructor() {
        this.centroidXY = new Point(0, 0);
        this.vertexArrayOffset = 0;
        this.vertexCount = 0;
        this.groundVertexArrayOffset = 0;
        this.groundVertexCount = 0;
        this.flags = 0;
        this.footprintSegIdx = -1;
        this.footprintSegLen = 0;
        this.min = new Point(Number.MAX_VALUE, Number.MAX_VALUE);
        this.max = new Point(-Number.MAX_VALUE, -Number.MAX_VALUE);
    }

    span(): Point {
        return new Point(this.max.x - this.min.x, this.max.y - this.min.y);
    }
}

// Used for calculating centroid of a feature and intersections of a feature with tile borders.
// Uses and extends data in PartData. References to PartData via centroidDataIndex.
class BorderCentroidData {
    acc: Point;
    accCount: number;
    borders: ?Array<[number, number]>; // Array<[min, max]>
    centroidDataIndex: number;

    constructor() {
        this.acc = new Point(0, 0);
        this.accCount = 0;
        this.centroidDataIndex = 0;
    }

    startRing(data: PartData, p: Point) {
        if (data.min.x === Number.MAX_VALUE) {  // If not initialized.
            data.min.x = data.max.x = p.x;
            data.min.y = data.max.y = p.y;
        }
    }

    appendEdge(data: PartData, p: Point, prev: Point) {
        assert(data.min.x !== Number.MAX_VALUE);

        this.accCount++;
        this.acc._add(p);

        let checkBorders = !!this.borders;

        if (p.x < data.min.x) {
            data.min.x = p.x;
            checkBorders = true;
        } else if (p.x > data.max.x) {
            data.max.x = p.x;
            checkBorders = true;
        }

        if (p.y < data.min.y) {
            data.min.y = p.y;
            checkBorders = true;
        } else if (p.y > data.max.y) {
            data.max.y = p.y;
            checkBorders = true;
        }

        if (((p.x === 0 || p.x === EXTENT) && p.x === prev.x) !==
            ((p.y === 0 || p.y === EXTENT) && p.y === prev.y)) {
            // Custom defined geojson buildings are cut on borders. Points are
            // repeated when edge cuts tile corner (reason for using xor).
            this.processBorderOverlap(p, prev);
        }

        if (checkBorders) {
            this.checkBorderIntersection(p, prev);
        }
    }

    checkBorderIntersection(p: Point, prev: Point) {
        if ((prev.x < 0) !== (p.x < 0)) {
            this.addBorderIntersection(0, interpolate(prev.y, p.y, (0 - prev.x) / (p.x - prev.x)));
        }
        if ((prev.x > EXTENT) !== (p.x > EXTENT)) {
            this.addBorderIntersection(1, interpolate(prev.y, p.y, (EXTENT - prev.x) / (p.x - prev.x)));
        }
        if ((prev.y < 0) !== (p.y < 0)) {
            this.addBorderIntersection(2, interpolate(prev.x, p.x, (0 - prev.y) / (p.y - prev.y)));
        }
        if ((prev.y > EXTENT) !== (p.y > EXTENT)) {
            this.addBorderIntersection(3, interpolate(prev.x, p.x, (EXTENT - prev.y) / (p.y - prev.y)));
        }
    }

    addBorderIntersection(index: 0 | 1 | 2 | 3, i: number) {
        if (!this.borders) {
            this.borders = [
                [Number.MAX_VALUE, -Number.MAX_VALUE],
                [Number.MAX_VALUE, -Number.MAX_VALUE],
                [Number.MAX_VALUE, -Number.MAX_VALUE],
                [Number.MAX_VALUE, -Number.MAX_VALUE]
            ];
        }
        const b = this.borders[index];
        if (i < b[0]) b[0] = i;
        if (i > b[1]) b[1] = i;
    }

    processBorderOverlap(p: Point, prev: Point) {
        if (p.x === prev.x) {
            if (p.y === prev.y) return; // custom defined geojson could have points repeated.
            const index = p.x === 0 ? 0 : 1;
            this.addBorderIntersection(index, prev.y);
            this.addBorderIntersection(index, p.y);
        } else {
            assert(p.y === prev.y);
            const index = p.y === 0 ? 2 : 3;
            this.addBorderIntersection(index, prev.x);
            this.addBorderIntersection(index, p.x);
        }
    }

    centroid(): Point {
        if (this.accCount === 0) {
            return new Point(0, 0);
        }
        return new Point(
            Math.floor(Math.max(0, this.acc.x) / this.accCount),
            Math.floor(Math.max(0, this.acc.y) / this.accCount));
    }

    intersectsCount(): number {
        if (!this.borders) {
            return 0;
        }
        return this.borders.reduce((acc, p) => acc + +(p[0] !== Number.MAX_VALUE), 0);
    }
}

export class GroundEffect {
    vertexArray: FillExtrusionGroundLayoutArray;
    vertexBuffer: VertexBuffer;

    hiddenByLandmarkVertexArray: FillExtrusionHiddenByLandmarkArray;
    hiddenByLandmarkVertexBuffer: VertexBuffer;
    needsHiddenByLandmarkUpdate: boolean;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    segments: SegmentVector;

    programConfigurations: ProgramConfigurationSet<FillExtrusionStyleLayer>;

    constructor(options: BucketParameters<FillExtrusionStyleLayer>) {
        this.vertexArray = new FillExtrusionGroundLayoutArray();
        this.indexArray = new TriangleIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.hiddenByLandmarkVertexArray = new FillExtrusionHiddenByLandmarkArray();
    }

    hasData(): boolean { return this.vertexArray.length !== 0; }

    addData(polyline: Array<Point>, angularOffsetFactors: Array<number>, bounds: [Point, Point]) {
        const n = polyline.length;
        assert(n === angularOffsetFactors.length);
        if (n > 2) {
            const segment = this.segments.prepareSegment(n * 4, this.vertexArray, this.indexArray);
            for (let i = 0; i < n; i++) {
                const j = i === n - 1 ? 0 : i + 1;
                const pa = polyline[i];
                const pb = polyline[j];
                const a0 = angularOffsetFactors[i];
                const a1 = angularOffsetFactors[j];

                if (isEdgeOutsideBounds(pa, pb, bounds) ||
                    (pointOutsideBounds(pa, bounds) && pointOutsideBounds(pb, bounds))) continue;

                const idx = segment.vertexLength;

                addGroundVertex(this.vertexArray, pa, pb, 1, 1, a0);
                addGroundVertex(this.vertexArray, pa, pb, 1, 0, a0);
                addGroundVertex(this.vertexArray, pa, pb, 0, 1, a1);
                addGroundVertex(this.vertexArray, pa, pb, 0, 0, a1);
                segment.vertexLength += 4;

                this.indexArray.emplaceBack(idx, idx + 1, idx + 3);
                this.indexArray.emplaceBack(idx, idx + 3, idx + 2);
                segment.primitiveLength += 2;
            }
        }
    }

    addPaintPropertiesData(feature: Feature, index: number, imagePositions: SpritePositions, availableImages: Array<string>, canonical: CanonicalTileID, brightness: ?number) {
        if (!this.hasData()) return;
        this.programConfigurations.populatePaintArrays(this.vertexArray.length, feature, index, imagePositions, availableImages, canonical, brightness);
    }

    upload(context: Context) {
        if (!this.hasData()) return;
        this.vertexBuffer = context.createVertexBuffer(this.vertexArray, fillExtrusionGroundAttributes.members);
        this.indexBuffer = context.createIndexBuffer(this.indexArray);
    }

    uploadPaintProperties(context: Context) {
        if (!this.hasData()) return;
        this.programConfigurations.upload(context);
    }

    update(states: FeatureStates, vtLayer: IVectorTileLayer, layers: any, availableImages: Array<string>, imagePositions: SpritePositions, brightness: ?number) {
        if (!this.hasData()) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, layers, availableImages, imagePositions, brightness);
    }

    updateHiddenByLandmark(data: PartData) {
        if (!this.hasData()) return;
        const offset = data.groundVertexArrayOffset;
        const vertexArrayBounds = data.groundVertexCount + data.groundVertexArrayOffset;
        assert(vertexArrayBounds <= this.hiddenByLandmarkVertexArray.length);
        assert(this.hiddenByLandmarkVertexArray.length === this.vertexArray.length);
        if (data.groundVertexCount === 0) return;
        const hide = data.flags & PartData.HiddenByReplacement ? 1 : 0;
        for (let i = offset; i < vertexArrayBounds; ++i) {
            this.hiddenByLandmarkVertexArray.emplace(i, hide);
        }
        this.needsHiddenByLandmarkUpdate = true;
    }

    uploadHiddenByLandmark(context: Context) {
        if (!this.hasData() || !this.needsHiddenByLandmarkUpdate) {
            return;
        }
        if (!this.hiddenByLandmarkVertexBuffer && this.hiddenByLandmarkVertexArray.length > 0) {
            // Create centroids vertex buffer
            this.hiddenByLandmarkVertexBuffer = context.createVertexBuffer(this.hiddenByLandmarkVertexArray, hiddenByLandmarkAttributes.members, true);
        } else if (this.hiddenByLandmarkVertexBuffer) {
            this.hiddenByLandmarkVertexBuffer.updateData(this.hiddenByLandmarkVertexArray);
        }
        this.needsHiddenByLandmarkUpdate = false;
    }

    destroy() {
        if (!this.vertexBuffer) return;
        this.vertexBuffer.destroy();
        this.indexBuffer.destroy();
        if (this.hiddenByLandmarkVertexBuffer) {
            this.hiddenByLandmarkVertexBuffer.destroy();
        }
        this.segments.destroy();
        this.programConfigurations.destroy();
    }
}

class FillExtrusionBucket implements Bucket {
    index: number;
    zoom: number;
    canonical: CanonicalTileID;
    overscaling: number;
    layers: Array<FillExtrusionStyleLayer>;
    layerIds: Array<string>;
    stateDependentLayers: Array<FillExtrusionStyleLayer>;
    stateDependentLayerIds: Array<string>;

    layoutVertexArray: FillExtrusionLayoutArray;
    layoutVertexBuffer: VertexBuffer;

    centroidVertexArray: FillExtrusionCentroidArray;
    centroidVertexBuffer: VertexBuffer;

    layoutVertexExtArray: ?FillExtrusionExtArray;
    layoutVertexExtBuffer: ?VertexBuffer;

    indexArray: TriangleIndexArray;
    indexBuffer: IndexBuffer;

    footprintSegments: Array<FootprintSegment>
    footprintVertices: PosArray;
    footprintIndices: TriangleIndexArray;

    hasPattern: boolean;
    edgeRadius: number;
    programConfigurations: ProgramConfigurationSet<FillExtrusionStyleLayer>;
    segments: SegmentVector;
    uploaded: boolean;
    features: Array<BucketFeature>;

    featuresOnBorder: Array<BorderCentroidData>;
    borderFeatureIndices: Array<Array<number>>;
    centroidData: Array<PartData>;
    // borders / borderDoneWithNeighborZ: 0 - left, 1, right, 2 - top, 3 - bottom
    borderDoneWithNeighborZ: Array<number>;
    needsCentroidUpdate: boolean;
    tileToMeter: number; // cache conversion.
    projection: ProjectionSpecification;
    activeReplacements: Array<any>;
    replacementUpdateTime: number;

    groundEffect: GroundEffect;

    constructor(options: BucketParameters<FillExtrusionStyleLayer>) {
        this.zoom = options.zoom;
        this.canonical = options.canonical;
        this.overscaling = options.overscaling;
        this.layers = options.layers;
        this.layerIds = this.layers.map(layer => layer.id);
        this.index = options.index;
        this.hasPattern = false;
        this.edgeRadius = 0;
        this.projection = options.projection;
        this.activeReplacements = [];
        this.replacementUpdateTime = 0;
        this.centroidData = [];
        this.footprintIndices = new TriangleIndexArray();
        this.footprintVertices = new PosArray();
        this.footprintSegments = [];

        this.layoutVertexArray = new FillExtrusionLayoutArray();
        this.centroidVertexArray = new FillExtrusionCentroidArray();
        this.indexArray = new TriangleIndexArray();
        this.programConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
        this.segments = new SegmentVector();
        this.stateDependentLayerIds = this.layers.filter((l) => l.isStateDependent()).map((l) => l.id);
        this.groundEffect = new GroundEffect(options);
    }

    populate(features: Array<IndexedFeature>, options: PopulateParameters, canonical: CanonicalTileID, tileTransform: TileTransform) {
        this.features = [];
        this.hasPattern = hasPattern('fill-extrusion', this.layers, options);
        this.featuresOnBorder = [];
        this.borderFeatureIndices = [[], [], [], []];
        this.borderDoneWithNeighborZ = [-1, -1, -1, -1];
        this.tileToMeter = tileToMeter(canonical);
        this.edgeRadius = this.layers[0].layout.get('fill-extrusion-edge-radius') / this.tileToMeter;

        for (const {feature, id, index, sourceLayerIndex} of features) {
            const needGeometry = this.layers[0]._featureFilter.needGeometry;
            const evaluationFeature = toEvaluationFeature(feature, needGeometry);

            // $FlowFixMe[method-unbinding]
            if (!this.layers[0]._featureFilter.filter(new EvaluationParameters(this.zoom), evaluationFeature, canonical)) continue;

            const bucketFeature: BucketFeature = {
                id,
                sourceLayerIndex,
                index,
                geometry: needGeometry ? evaluationFeature.geometry : loadGeometry(feature, canonical, tileTransform),
                properties: feature.properties,
                type: feature.type,
                patterns: {}
            };

            const vertexArrayOffset = this.layoutVertexArray.length;
            if (this.hasPattern) {
                this.features.push(addPatternDependencies('fill-extrusion', this.layers, bucketFeature, this.zoom, options));
            } else {
                this.addFeature(bucketFeature, bucketFeature.geometry, index, canonical, {}, options.availableImages, tileTransform, options.brightness);
            }

            options.featureIndex.insert(feature, bucketFeature.geometry, index, sourceLayerIndex, this.index, vertexArrayOffset);
        }
        this.sortBorders();
    }

    addFeatures(options: PopulateParameters, canonical: CanonicalTileID, imagePositions: SpritePositions, availableImages: Array<string>, tileTransform: TileTransform, brightness: ?number) {
        for (const feature of this.features) {
            const {geometry} = feature;
            this.addFeature(feature, geometry, feature.index, canonical, imagePositions, availableImages, tileTransform, brightness);
        }
        this.sortBorders();
    }

    update(states: FeatureStates, vtLayer: IVectorTileLayer, availableImages: Array<string>, imagePositions: SpritePositions, brightness: ?number) {
        if (!this.stateDependentLayers.length) return;
        this.programConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, availableImages, imagePositions, brightness);
        this.groundEffect.update(states, vtLayer, this.stateDependentLayers, availableImages, imagePositions, brightness);
    }

    isEmpty(): boolean {
        return this.layoutVertexArray.length === 0;
    }

    uploadPending(): boolean {
        return !this.uploaded || this.programConfigurations.needsUpload || this.groundEffect.programConfigurations.needsUpload;
    }

    upload(context: Context) {
        if (!this.uploaded) {
            this.layoutVertexBuffer = context.createVertexBuffer(this.layoutVertexArray, layoutAttributes);
            this.indexBuffer = context.createIndexBuffer(this.indexArray);

            if (this.layoutVertexExtArray) {
                this.layoutVertexExtBuffer = context.createVertexBuffer(this.layoutVertexExtArray, fillExtrusionAttributesExt.members, true);
            }

            this.groundEffect.upload(context);
        }
        this.groundEffect.uploadPaintProperties(context);
        this.programConfigurations.upload(context);
        this.uploaded = true;
    }

    uploadCentroid(context: Context) {
        this.groundEffect.uploadHiddenByLandmark(context);
        if (!this.needsCentroidUpdate) {
            return;
        }
        if (!this.centroidVertexBuffer && this.centroidVertexArray.length > 0) {
            // Create centroids vertex buffer
            this.centroidVertexBuffer = context.createVertexBuffer(this.centroidVertexArray, centroidAttributes.members, true);
        } else if (this.centroidVertexBuffer) {
            this.centroidVertexBuffer.updateData(this.centroidVertexArray);
        }
        this.needsCentroidUpdate = false;
    }

    destroy() {
        if (!this.layoutVertexBuffer) return;
        this.layoutVertexBuffer.destroy();
        if (this.centroidVertexBuffer) {
            this.centroidVertexBuffer.destroy();
        }
        if (this.layoutVertexExtBuffer) {
            this.layoutVertexExtBuffer.destroy();
        }
        this.groundEffect.destroy();
        this.indexBuffer.destroy();
        this.programConfigurations.destroy();
        this.segments.destroy();
    }

    addFeature(feature: BucketFeature, geometry: Array<Array<Point>>, index: number, canonical: CanonicalTileID, imagePositions: SpritePositions, availableImages: Array<string>, tileTransform: TileTransform, brightness: ?number) {
        const tileBounds = [new Point(0, 0), new Point(EXTENT, EXTENT)];
        const projection = tileTransform.projection;
        const isGlobe = projection.name === 'globe';
        const isPolygon = vectorTileFeatureTypes[feature.type] === 'Polygon';

        const borderCentroidData = new BorderCentroidData();
        borderCentroidData.centroidDataIndex = this.centroidData.length;
        const centroid = new PartData();
        centroid.vertexArrayOffset = this.layoutVertexArray.length;
        centroid.groundVertexArrayOffset = this.groundEffect.vertexArray.length;

        if (isGlobe && !this.layoutVertexExtArray) {
            this.layoutVertexExtArray = new FillExtrusionExtArray();
        }

        const polygons = classifyRings(geometry, EARCUT_MAX_RINGS);

        for (let i = polygons.length - 1; i >= 0; i--) {
            const polygon = polygons[i];
            if (polygon.length === 0 || isEntirelyOutside(polygon[0])) {
                polygons.splice(i, 1);
            }
        }

        let clippedPolygons: ClippedPolygon[];
        if (isGlobe) {
            // Perform tesselation for polygons of tiles in order to support long planar
            // triangles on the curved surface of the globe. This is done for all polygons
            // regardless of their size in order guarantee identical results on all sides of
            // tile boundaries.
            //
            // The globe is subdivided into a 32x16 grid. The number of subdivisions done
            // for a tile depends on the zoom level. For example tile with z=0 requires 2⁴
            // subdivisions, tile with z=1 2³ etc. The subdivision is done in polar coordinates
            // instead of tile coordinates.
            clippedPolygons = resampleFillExtrusionPolygonsForGlobe(polygons, tileBounds, canonical);
        } else {
            clippedPolygons = [];
            for (const polygon of polygons) {
                clippedPolygons.push({polygon, bounds: tileBounds});
            }
        }

        const concavity = (a: Point, b: Point) => {
            return a.x * b.y - a.y * b.x < 0 ? -1 : 1;
        };

        const tanAngleClamped = (angle: number) => {
            return Math.min(TANGENT_CUTOFF, Math.max(-TANGENT_CUTOFF, Math.tan(angle))) / TANGENT_CUTOFF * FACTOR;
        };

        const getAngularOffsetFactor = (a: Point, b: Point, angle: number) => {
            return tanAngleClamped(angle) * concavity(a, b);
        };

        const edgeRadius = isPolygon ? this.edgeRadius : 0;

        for (const {polygon, bounds} of clippedPolygons) {
            // Only triangulate and draw the area of the feature if it is a polygon
            // Other feature types (e.g. LineString) do not have area, so triangulation is pointless / undefined
            let topIndex = 0;
            let numVertices = 0;
            for (const ring of polygon) {
                // make sure the ring closes
                if (isPolygon && !ring[0].equals(ring[ring.length - 1])) ring.push(ring[0]);
                numVertices += (isPolygon ? (ring.length - 1) : ring.length);
            }

            // We use "(isPolygon ? 5 : 4) * numVertices" as an estimate to ensure whether additional segments are needed or not (see SegmentVector.MAX_VERTEX_ARRAY_LENGTH).
            const segment = this.segments.prepareSegment((isPolygon ? 5 : 4) * numVertices, this.layoutVertexArray, this.indexArray);

            if (centroid.footprintSegIdx < 0) {
                centroid.footprintSegIdx = this.footprintSegments.length;
            }

            const fpSegment = new FootprintSegment();
            fpSegment.vertexOffset = this.footprintVertices.length;
            fpSegment.indexOffset = this.footprintIndices.length * 3;

            if (isPolygon) {
                const flattened = [];
                const holeIndices = [];
                topIndex = segment.vertexLength;

                // First we offset (inset) the top vertices (i.e the vertices that make up the roof).
                for (let r = 0; r < polygon.length; r++) {
                    const ring = polygon[r];
                    if (ring.length && r !== 0) {
                        holeIndices.push(flattened.length / 2);
                    }

                    // Geometry used by ground flood light and AO.
                    const groundPolyline: Array<Point> = [];
                    const angularOffsetFactors: Array<number> = [];

                    // The following vectors are used to avoid duplicate normal calculations when going over the vertices.
                    let na, nb;
                    {
                        const p0 = ring[0];
                        const p1 = ring[1];
                        na = p1.sub(p0)._perp()._unit();
                    }
                    for (let i = 1; i < ring.length; i++) {
                        const p1 = ring[i];
                        const p2 = ring[i === ring.length - 1 ? 1 : i + 1];

                        let {x, y} = p1;

                        nb = p2.sub(p1)._perp()._unit();
                        const nm = na.add(nb)._unit();
                        const cosHalfAngle = na.x * nm.x + na.y * nm.y;

                        if (edgeRadius) {
                            const offset = edgeRadius * Math.min(4, 1 / cosHalfAngle);
                            x += offset * nm.x;
                            y += offset * nm.y;
                        }

                        if (edgeRadius === 0) {
                            groundPolyline.push(p1);
                            const factor = getAngularOffsetFactor(na, nb, Math.acos(cosHalfAngle));
                            angularOffsetFactors.push(factor);
                        }

                        addVertex(this.layoutVertexArray, x, y, 0, 0, 1, 1, 0);
                        segment.vertexLength++;

                        this.footprintVertices.emplaceBack(p1.x, p1.y);

                        // triangulate as if vertices were not offset to ensure correct triangulation
                        flattened.push(p1.x, p1.y);

                        if (isGlobe) {
                            const array: any = this.layoutVertexExtArray;
                            const projectedP = projection.projectTilePoint(x, y, canonical);
                            const n = projection.upVector(canonical, x, y);
                            addGlobeExtVertex(array, projectedP, n);
                        }

                        na = nb;
                    }

                    if (edgeRadius === 0) {
                        this.groundEffect.addData(groundPolyline, angularOffsetFactors, bounds);
                    }
                }

                const indices = earcut(flattened, holeIndices);
                assert(indices.length % 3 === 0);

                for (let j = 0; j < indices.length; j += 3) {
                    this.footprintIndices.emplaceBack(
                        fpSegment.vertexOffset + indices[j + 0],
                        fpSegment.vertexOffset + indices[j + 1],
                        fpSegment.vertexOffset + indices[j + 2]);

                    // clockwise winding order.
                    this.indexArray.emplaceBack(
                        topIndex + indices[j],
                        topIndex + indices[j + 2],
                        topIndex + indices[j + 1]);
                    segment.primitiveLength++;
                }

                fpSegment.indexCount += indices.length;
                fpSegment.vertexCount += this.footprintVertices.length - fpSegment.vertexOffset;
            }

            for (let r = 0; r < polygon.length; r++) {
                const ring = polygon[r];
                borderCentroidData.startRing(centroid, ring[0]);
                let isPrevCornerConcave = ring.length > 4 && isAOConcaveAngle(ring[ring.length - 2], ring[0], ring[1]);
                let offsetPrev = edgeRadius ? getRoundedEdgeOffset(ring[ring.length - 2], ring[0], ring[1], edgeRadius) : 0;
                let prevAngularOffsetFactor = tanAngleClamped(Math.PI / 4);
                // Geometry used by ground flood light and AO.
                const groundPolyline: Array<Point> = [];
                const angularOffsetFactors: Array<number> = [];

                let kFirst;

                // The following vectors are used to avoid duplicate normal calculations when going over the vertices.
                let na, nb;
                {
                    const p0 = ring[0];
                    const p1 = ring[1];
                    na = p1.sub(p0)._perp()._unit();
                }
                let cap = true;
                for (let i = 1, edgeDistance = 0; i < ring.length; i++) {
                    let p0 = ring[i - 1];
                    let p1 = ring[i];
                    const p2 = ring[i === ring.length - 1 ? 1 : i + 1];

                    borderCentroidData.appendEdge(centroid, p1, p0);

                    if (isEdgeOutsideBounds(p1, p0, bounds)) {
                        if (edgeRadius) {
                            na = p2.sub(p1)._perp()._unit();
                            cap = !cap;
                        }
                        continue;
                    }

                    const d = p1.sub(p0)._perp();
                    // Given that nz === 0, encode nx / (abs(nx) + abs(ny)) and signs.
                    // This information is sufficient to reconstruct normal vector in vertex shader.
                    const nxRatio = d.x / (Math.abs(d.x) + Math.abs(d.y));
                    const nySign = d.y > 0 ? 1 : 0;

                    const dist = p0.dist(p1);
                    if (edgeDistance + dist > 32768) edgeDistance = 0;

                    // Next offset the vertices along the edges and create a chamfer space between them:
                    // So if we have the following (where 'x' denotes a vertex)
                    // x──────x
                    // |      |
                    // |      |
                    // |      |
                    // |      |
                    // x──────x
                    // we end up with:
                    //  x────x
                    // x      x
                    // |      |
                    // |      |
                    // x      x
                    //  x────x
                    // (drawing isn't exact but hopefully gets the point across).

                    if (edgeRadius) {
                        nb = p2.sub(p1)._perp()._unit();

                        const cosHalfAngle = getCosHalfAngle(na, nb);
                        let offsetNext = _getRoundedEdgeOffset(p0, p1, p2, cosHalfAngle, edgeRadius);

                        if (isNaN(offsetNext)) offsetNext = 0;
                        const nEdge = p1.sub(p0)._unit();
                        const mEdge = p2.sub(p1)._unit();

                        p0 = p0.add(nEdge.mult(offsetPrev))._round();
                        p1 = p1.add(nEdge.mult(-offsetNext))._round();
                        offsetPrev = offsetNext;

                        const pa = ring[i].add(mEdge.mult(offsetNext))._round();
                        const pap1 = pa.sub(p1)._perp()._unit();
                        const currentAngularOffsetFactor = getAngularOffsetFactor(na, pap1, Math.acos(getCosHalfAngle(na, pap1)));

                        groundPolyline.push(p0);
                        angularOffsetFactors.push(prevAngularOffsetFactor);
                        groundPolyline.push(p1);
                        angularOffsetFactors.push(currentAngularOffsetFactor);

                        prevAngularOffsetFactor = getAngularOffsetFactor(pap1, nb, Math.acos(getCosHalfAngle(nb, pap1)));
                        na = nb;
                    }

                    const k = segment.vertexLength;

                    const isConcaveCorner = ring.length > 4 && isAOConcaveAngle(p0, p1, p2);
                    let encodedEdgeDistance = encodeAOToEdgeDistance(edgeDistance, isPrevCornerConcave, cap);

                    addVertex(this.layoutVertexArray, p0.x, p0.y, nxRatio, nySign, 0, 0, encodedEdgeDistance);
                    addVertex(this.layoutVertexArray, p0.x, p0.y, nxRatio, nySign, 0, 1, encodedEdgeDistance);

                    edgeDistance += dist;
                    encodedEdgeDistance = encodeAOToEdgeDistance(edgeDistance, isConcaveCorner, !cap);
                    isPrevCornerConcave = isConcaveCorner;

                    addVertex(this.layoutVertexArray, p1.x, p1.y, nxRatio, nySign, 0, 0, encodedEdgeDistance);
                    addVertex(this.layoutVertexArray, p1.x, p1.y, nxRatio, nySign, 0, 1, encodedEdgeDistance);

                    segment.vertexLength += 4;

                    // ┌──────┐
                    // │ 1  3 │ clockwise winding order.
                    // │      │ Triangle 1: 0 => 1 => 2
                    // │ 0  2 │ Triangle 2: 1 => 3 => 2
                    // └──────┘
                    this.indexArray.emplaceBack(k + 0, k + 1, k + 2);
                    this.indexArray.emplaceBack(k + 1, k + 3, k + 2);
                    segment.primitiveLength += 2;

                    if (edgeRadius) {
                        // Note that in the previous for-loop we start from index 1 to add the top vertices which explains the next line.
                        const t0 = topIndex + (i === 1 ? ring.length - 2 : i - 2);
                        const t1 = i === 1 ? topIndex : t0 + 1;

                        // top chamfer along the side (i.e. the space between the wall and the roof).
                        this.indexArray.emplaceBack(k + 1, t0, k + 3);
                        this.indexArray.emplaceBack(t0, t1, k + 3);
                        segment.primitiveLength += 2;

                        if (kFirst === undefined) {
                            kFirst = k;
                        }

                        // Make sure to fill in the gap in the corner only when both corresponding edges are in tile bounds.
                        if (!isEdgeOutsideBounds(p2, ring[i], bounds)) {
                            const l = i === ring.length - 1 ? kFirst : segment.vertexLength;

                            // vertical side chamfer i.e. the space between consecutive walls.
                            this.indexArray.emplaceBack(k + 2, k + 3, l);
                            this.indexArray.emplaceBack(k + 3, l + 1, l);

                            // top corner where the top(roof) and two sides(walls) meet.
                            this.indexArray.emplaceBack(k + 3, t1, l + 1);

                            segment.primitiveLength += 3;
                        }
                        cap = !cap;
                    }

                    if (isGlobe) {
                        const array: any = this.layoutVertexExtArray;

                        const projectedP0 = projection.projectTilePoint(p0.x, p0.y, canonical);
                        const projectedP1 = projection.projectTilePoint(p1.x, p1.y, canonical);

                        const n0 = projection.upVector(canonical, p0.x, p0.y);
                        const n1 = projection.upVector(canonical, p1.x, p1.y);

                        addGlobeExtVertex(array, projectedP0, n0);
                        addGlobeExtVertex(array, projectedP0, n0);
                        addGlobeExtVertex(array, projectedP1, n1);
                        addGlobeExtVertex(array, projectedP1, n1);
                    }
                }
                if (isPolygon) topIndex += (ring.length - 1);
                if (edgeRadius) {
                    this.groundEffect.addData(groundPolyline, angularOffsetFactors, bounds);
                }
            }
            this.footprintSegments.push(fpSegment);
            ++centroid.footprintSegLen;
        }

        assert(!isGlobe || (this.layoutVertexExtArray && this.layoutVertexExtArray.length === this.layoutVertexArray.length));

        centroid.vertexCount = this.layoutVertexArray.length - centroid.vertexArrayOffset;
        centroid.groundVertexCount = this.groundEffect.vertexArray.length - centroid.groundVertexArrayOffset;
        if (centroid.vertexCount === 0) {
            return;
        }

        // hiddenCentroid {0, 1}: it is initially hidden as borders are processed later.
        centroid.centroidXY = borderCentroidData.borders ? PartData.hiddenCentroid : this.encodeCentroid(borderCentroidData, centroid);
        this.centroidData.push(centroid);

        if (borderCentroidData.borders) {
            // When building is split between tiles, store information that enables joining.
            // parts of building that layes in differentt buckets.
            assert(borderCentroidData.centroidDataIndex === this.centroidData.length - 1);
            this.featuresOnBorder.push(borderCentroidData);
            const borderIndex = this.featuresOnBorder.length - 1;
            for (let i = 0; i < (borderCentroidData.borders: any).length; i++) {
                if ((borderCentroidData.borders: any)[i][0] !== Number.MAX_VALUE) {
                    this.borderFeatureIndices[i].push(borderIndex);
                }
            }
        }

        this.programConfigurations.populatePaintArrays(this.layoutVertexArray.length, feature, index, imagePositions, availableImages, canonical, brightness);
        this.groundEffect.addPaintPropertiesData(feature, index, imagePositions, availableImages, canonical, brightness);
    }

    sortBorders() {
        for (let i = 0; i < this.borderFeatureIndices.length; i++) {
            const borders = this.borderFeatureIndices[i];
            borders.sort((a, b) => (this.featuresOnBorder[a].borders: any)[i][0] - (this.featuresOnBorder[b].borders: any)[i][0]);
        }
    }

    // Encoded centroid x and y:
    //     x     y
    // ---------------------------------------------
    //     0     0    Default, no flat roof.
    //     0     1    Hide, used to hide parts of buildings on border while expecting the other side to get loaded
    //    >0     0    Elevation encoded to uint16 word
    //    >0    >0    Encoded centroid position and x & y span
    encodeCentroid(borderCentroidData: BorderCentroidData, data: PartData): Point {
        const c = borderCentroidData.centroid();
        const span = data.span();
        const spanX = Math.min(7, Math.round(span.x * this.tileToMeter / 10));
        const spanY = Math.min(7, Math.round(span.y * this.tileToMeter / 10));
        return new Point((clamp(c.x, 1, EXTENT - 1) << 3) | spanX, (clamp(c.y, 1, EXTENT - 1) << 3) | spanY);
    }

    showCentroid(borderCentroidData: BorderCentroidData) {
        const c = this.centroidData[borderCentroidData.centroidDataIndex];
        c.flags &= PartData.HiddenByReplacement;
        c.centroidXY.x = 0;
        c.centroidXY.y = 0;
        this.writeCentroidToBuffer(c);
    }

    writeCentroidToBuffer(data: PartData) {
        this.groundEffect.updateHiddenByLandmark(data);
        const offset = data.vertexArrayOffset;
        const vertexArrayBounds = data.vertexCount + data.vertexArrayOffset;
        assert(vertexArrayBounds <= this.centroidVertexArray.length);
        assert(this.centroidVertexArray.length === this.layoutVertexArray.length);
        const c = data.flags & PartData.HiddenByReplacement ? PartData.hiddenCentroid : data.centroidXY;
        // All the vertex data is the same, use the first to exit early if it is not needed to re-write all.
        const firstX = this.centroidVertexArray.geta_centroid_pos0(offset);
        const firstY = this.centroidVertexArray.geta_centroid_pos1(offset);

        if (firstY === c.y && firstX === c.x) {
            return;
        }
        for (let i = offset; i < vertexArrayBounds; ++i) {
            this.centroidVertexArray.emplace(i, c.x, c.y);
        }
        this.needsCentroidUpdate = true;
    }

    createCentroidsBuffer() {
        assert(this.centroidVertexArray.length === 0);
        assert(this.groundEffect.hiddenByLandmarkVertexArray.length === 0);
        this.centroidVertexArray.resize(this.layoutVertexArray.length);
        this.groundEffect.hiddenByLandmarkVertexArray.resize(this.groundEffect.vertexArray.length);
        for (const centroid of this.centroidData) {
            this.writeCentroidToBuffer(centroid);
        }
    }

    updateReplacement(coord: OverscaledTileID, source: ReplacementSource) {
        // Replacement has to be re-checked if the source has been updated since last time
        if (source.updateTime === this.replacementUpdateTime) {
            return;
        }
        this.replacementUpdateTime = source.updateTime;

        // Check if replacements have changed
        const newReplacements = source.getReplacementRegionsForTile(coord.toUnwrapped());
        if (regionsEquals(this.activeReplacements, newReplacements)) {
            return;
        }
        this.activeReplacements = newReplacements;

        if (this.centroidVertexArray.length === 0) {
            this.createCentroidsBuffer();
        } else {
            for (const centroid of this.centroidData) {
                centroid.flags &= ~PartData.HiddenByReplacement;
            }
        }

        const transformedVertices: Array<Point> = [];

        // Hide all centroids that are overlapping with footprints from the replacement source
        for (const region of this.activeReplacements) {
            // Apply slight padding (one unit) to fill extrusion footprints. This reduces false positives where
            // two adjacent lines would be reported overlapping due to limited precision (16 bit) of tile units.
            const padding = Math.pow(2.0, region.footprintTileId.canonical.z - coord.canonical.z);

            for (const centroid of this.centroidData) {
                if (centroid.flags & PartData.HiddenByReplacement) {
                    continue;
                }

                // Perform a quick aabb-aabb check to determine
                // whether a more precise check is required
                if (region.min.x > centroid.max.x || centroid.min.x > region.max.x) {
                    continue;
                } else if (region.min.y > centroid.max.y || centroid.min.y > region.max.y) {
                    continue;
                }

                for (let i = 0; i < centroid.footprintSegLen; i++) {
                    const seg = this.footprintSegments[centroid.footprintSegIdx + i];

                    // Transform vertices to footprint's coordinate space
                    transformedVertices.length = 0;

                    transformFootprintVertices(
                        this.footprintVertices,
                        seg.vertexOffset,
                        seg.vertexCount,
                        region.footprintTileId.canonical,
                        coord.canonical,
                        transformedVertices);

                    if (footprintTrianglesIntersect(
                        region.footprint,
                        transformedVertices,
                        this.footprintIndices.uint16,
                        seg.indexOffset,
                        seg.indexCount,
                        -seg.vertexOffset,
                        -padding)) {
                        centroid.flags |= PartData.HiddenByReplacement;
                        break;
                    }
                }
            }
        }

        for (const centroid of this.centroidData) {
            this.writeCentroidToBuffer(centroid);
        }

        this.borderDoneWithNeighborZ = [-1, -1, -1, -1];
    }
}

function getCosHalfAngle(na: Point, nb: Point) {
    const nm = na.add(nb)._unit();
    const cosHalfAngle = na.x * nm.x + na.y * nm.y;
    return cosHalfAngle;
}

function getRoundedEdgeOffset(p0: Point, p1: Point, p2: Point, edgeRadius: number) {
    const na = p1.sub(p0)._perp()._unit();
    const nb = p2.sub(p1)._perp()._unit();
    const cosHalfAngle = getCosHalfAngle(na, nb);
    return _getRoundedEdgeOffset(p0, p1, p2, cosHalfAngle, edgeRadius);
}

function _getRoundedEdgeOffset(p0: Point, p1: Point, p2: Point, cosHalfAngle: number, edgeRadius: number) {
    const sinHalfAngle = Math.sqrt(1 - cosHalfAngle * cosHalfAngle);
    return Math.min(p0.dist(p1) / 3, p1.dist(p2) / 3, edgeRadius * sinHalfAngle / cosHalfAngle);
}

register(FillExtrusionBucket, 'FillExtrusionBucket', {omit: ['layers', 'features']});
register(PartData, 'PartData');
register(FootprintSegment, 'FootprintSegment');
register(BorderCentroidData, 'BorderCentroidData');
register(GroundEffect, 'GroundEffect');

export default FillExtrusionBucket;

// Edges that are outside tile bounds are defined in tile across the border.
// Rendering them twice often results with Z-fighting.
// In case of globe and axis aligned bounds, it is also useful to
// discard edges that have the both endpoints outside the same bound.
function isEdgeOutsideBounds(p1: Point, p2: Point, bounds: [Point, Point]) {
    return (p1.x < bounds[0].x && p2.x < bounds[0].x) ||
           (p1.x > bounds[1].x && p2.x > bounds[1].x) ||
           (p1.y < bounds[0].y && p2.y < bounds[0].y) ||
           (p1.y > bounds[1].y && p2.y > bounds[1].y);
}

function pointOutsideBounds(p: Point, bounds: [Point, Point]) {
    return ((p.x < bounds[0].x) || (p.x > bounds[1].x) ||
            (p.y < bounds[0].y) || (p.y > bounds[1].y));
}

function isEntirelyOutside(ring: Array<Point>) {
    // Discard rings with corners on border if all other vertices are outside: they get defined
    // also in the tile across the border. Eventual zero area rings at border are discarded by classifyRings
    // and there is no need to handle that case here.
    return ring.every(p => p.x <= 0) ||
        ring.every(p => p.x >= EXTENT) ||
        ring.every(p => p.y <= 0) ||
        ring.every(p => p.y >= EXTENT);
}

function isAOConcaveAngle(p2: Point, p1: Point, p3: Point) {
    if (p2.x < 0 || p2.x >= EXTENT || p1.x < 0 || p1.x >= EXTENT || p3.x < 0 || p3.x >= EXTENT) {
        return false; // angles are not processed for edges that extend over tile borders
    }
    const a = p3.sub(p1);
    const an = a.perp();
    const b = p2.sub(p1);
    const ab = a.x * b.x + a.y * b.y;
    const cosAB = ab / Math.sqrt(((a.x * a.x + a.y * a.y) * (b.x * b.x + b.y * b.y)));
    const dotProductWithNormal = an.x * b.x + an.y * b.y;

    // Heuristics: don't shade concave angles above 150° (arccos(-0.866)).
    return cosAB > -0.866 && dotProductWithNormal < 0;
}

function encodeAOToEdgeDistance(edgeDistance: number, isConcaveCorner: boolean, edgeStart: boolean) {
    // Encode concavity and edge start/end using the least significant bits.
    // Second least significant bit 1 encodes concavity.
    // The least significant bit 1 marks the edge start, 0 for edge end.
    const encodedEdgeDistance = isConcaveCorner ? (edgeDistance | 2) : (edgeDistance & ~2);
    return edgeStart ? (encodedEdgeDistance | 1) : (encodedEdgeDistance & ~1);
}

export function fillExtrusionHeightLift(): number {
    // A rectangle covering globe is subdivided into a grid of 32 cells
    // This information can be used to deduce a minimum lift value so that
    // fill extrusions with 0 height will never go below the ground.
    const angle = Math.PI / 32.0;
    const tanAngle = Math.tan(angle);
    const r = earthRadius;
    return r * Math.sqrt(1.0 + 2.0 * tanAngle * tanAngle) - r;
}

// Resamples fill extrusion polygons by subdividing them into 32x16 cells in mercator space.
// The idea is to allow reprojection of large continuous planar shapes on the surface of the globe
export function resampleFillExtrusionPolygonsForGlobe(polygons: Point[][][], tileBounds: [Point, Point], tileID: CanonicalTileID): ClippedPolygon[] {
    const cellCount = 360.0 / 32.0;
    const tiles = 1 << tileID.z;
    const leftLng = lngFromMercatorX(tileID.x / tiles);
    const rightLng = lngFromMercatorX((tileID.x + 1) / tiles);
    const topLat = latFromMercatorY(tileID.y / tiles);
    const bottomLat = latFromMercatorY((tileID.y + 1) / tiles);
    const cellCountOnXAxis = Math.ceil((rightLng - leftLng) / cellCount);
    const cellCountOnYAxis = Math.ceil((topLat - bottomLat) / cellCount);

    const splitFn = (axis: number, min: number, max: number) => {
        if (axis === 0) {
            return 0.5 * (min + max);
        } else {
            const maxLat = latFromMercatorY((tileID.y + min / EXTENT) / tiles);
            const minLat = latFromMercatorY((tileID.y + max / EXTENT) / tiles);
            const midLat = 0.5 * (minLat + maxLat);
            return (mercatorYfromLat(midLat) * tiles - tileID.y) * EXTENT;
        }
    };

    return subdividePolygons(polygons, tileBounds, cellCountOnXAxis, cellCountOnYAxis, 1.0, splitFn);
}

function transformFootprintVertices(vertices: PosArray, offset: number, count: number, footprintId: CanonicalTileID, centroidId: CanonicalTileID, out: Array<Point>) {
    const zDiff = Math.pow(2.0, footprintId.z - centroidId.z);

    for (let i = 0; i < count; i++) {
        let x = vertices.int16[(i + offset) * 2 + 0];
        let y = vertices.int16[(i + offset) * 2 + 1];

        x = (x + centroidId.x * EXTENT) * zDiff - footprintId.x * EXTENT;
        y = (y + centroidId.y * EXTENT) * zDiff - footprintId.y * EXTENT;

        out.push(new Point(x, y));
    }
}
