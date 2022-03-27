// @flow

import StencilMode from '../gl/stencil_mode.js';
import DepthMode from '../gl/depth_mode.js';
import ColorMode from '../gl/color_mode.js';
import CullFaceMode from '../gl/cull_face_mode.js';
import {globeToMercatorTransition} from './../geo/projection/globe_util.js';
import {atmosphereUniformValues} from '../terrain/globe_raster_program.js';
import type Painter from './painter.js';
import {degToRad, mapValue} from '../util/util.js';
import {vec3, mat4} from 'gl-matrix';

export default drawAtmosphere;

function project(point, m) {
    return vec3.transformMat4(point, point, m);
}

function drawAtmosphere(painter: Painter) {
    const fog = painter.style.fog;

    if (!fog) {
        return;
    }

    const context = painter.context;
    const gl = context.gl;
    const transform = painter.transform;
    const depthMode = new DepthMode(gl.LEQUAL, DepthMode.ReadOnly, [0, 1]);
    const defines = transform.projection.name === 'globe' ? ['PROJECTION_GLOBE_VIEW'] : [];
    const program = painter.useProgram('globeAtmosphere', null, defines);

    // Render the gradient atmosphere by casting rays from screen pixels and determining their
    // closest distance to the globe. This is done in view space where camera is located in the origo
    // facing -z direction.
    const offset = transform.centerOffset;
    const cameraToClip = transform._camera.getCameraToClipPerspective(transform._fov, transform.width / transform.height, transform._nearZ, transform._farZ);

    cameraToClip[8] = -offset.x * 2 / transform.width;
    cameraToClip[9] = offset.y * 2 / transform.height;

    const clipToCamera = mat4.invert([], cameraToClip);
    const viewMatrix = mat4.mul([], clipToCamera, transform.projMatrix);

    const horizonFromTopInClip = 1.0 - (transform.horizonLineFromTop() / transform.height) * 2.0;
    const horizonL = project([-1, horizonFromTopInClip, 1], clipToCamera);
    const horizonR = project([1, horizonFromTopInClip, 1], clipToCamera);

    // Compute direction vectors to each corner point of the view frustum
    const frustumTl = project([-1, 1, 1], clipToCamera);
    const frustumTr = project([1, 1, 1], clipToCamera);
    const frustumBr = project([1, -1, 1], clipToCamera);
    const frustumBl = project([-1, -1, 1], clipToCamera);

    const center = [transform.globeMatrix[12], transform.globeMatrix[13], transform.globeMatrix[14]];
    const globeCenterInViewSpace = project(center, viewMatrix);
    const globeRadius = transform.worldSize / 2.0 / Math.PI - 1.0;

    const transitionT = globeToMercatorTransition(transform.zoom);

    const fogOpacity = fog.getOpacity(transform.pitch);
    const fogColor = fog.properties.get('color');
    const fogColorUnpremultiplied = [
        fogColor.a === 0.0 ? 0 : fogColor.r / fogColor.a,
        fogColor.a === 0.0 ? 0 : fogColor.g / fogColor.a,
        fogColor.a === 0.0 ? 0 : fogColor.b / fogColor.a,
        fogColor.a
    ];
    const skyColor = fog.properties.get('sky-color');
    const skyColorUnpremultiplied = [
        skyColor.a === 0.0 ? 0 : skyColor.r / skyColor.a,
        skyColor.a === 0.0 ? 0 : skyColor.g / skyColor.a,
        skyColor.a === 0.0 ? 0 : skyColor.b / skyColor.a,
        skyColor.a
    ];
    const spaceColor = fog.properties.get('space-color');

    const temporalOffset = (painter.frameCounter / 1000.0) % 1;
    const latlon = [
        degToRad(transform._center.lat) / (Math.PI * 0.5),
        degToRad(transform._center.lng) / Math.PI
    ];

    const starIntensity = mapValue(fog.properties.get('star-intensity'), 0.0, 1.0, 0.0, 0.25);

    const globeCenterDistance = vec3.length(globeCenterInViewSpace);
    const distanceToHorizon = Math.sqrt(Math.pow(globeCenterDistance, 2.0) - Math.pow(globeRadius, 2.0));
    const horizonAngle = Math.acos(distanceToHorizon / globeCenterDistance);

    // https://www.desmos.com/calculator/oanvvpr36d
    const horizonBlend = mapValue(fog.properties.get('horizon-blend'), 0.0, 1.0, 0.0, 0.25);

    const uniforms = atmosphereUniformValues(
        frustumTl,
        frustumTr,
        frustumBr,
        frustumBl,
        horizonL,
        horizonR,
        globeCenterInViewSpace,
        globeRadius,
        transitionT,
        horizonBlend,
        fogColorUnpremultiplied,
        skyColorUnpremultiplied,
        [spaceColor.r, spaceColor.g, spaceColor.b, spaceColor.a],
        latlon,
        starIntensity,
        temporalOffset,
        horizonAngle);

    painter.prepareDrawProgram(context, program);

    const sharedBuffers = painter.globeSharedBuffers;
    if (sharedBuffers) {
        program.draw(context, gl.TRIANGLES, depthMode, StencilMode.disabled,
            ColorMode.alphaBlended, CullFaceMode.backCW, uniforms, "skybox",
            sharedBuffers.atmosphereVertexBuffer,
            sharedBuffers.atmosphereIndexBuffer,
            sharedBuffers.atmosphereSegments);
    }
}
