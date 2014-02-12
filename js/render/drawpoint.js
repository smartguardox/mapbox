'use strict';

module.exports = function drawPoint(gl, painter, layer, layerStyle, tile, stats, params, imageSprite) {

    var imagePos = imageSprite.getPosition(layerStyle.image),
        begin = layer.pointVertexIndex,
        count = layer.pointVertexIndexEnd - begin,
        shader = imagePos ? painter.pointShader : painter.dotShader;

    tile.geometry.pointVertex.bind(gl);

    gl.switchShader(shader, painter.translatedMatrix || painter.posMatrix, painter.exMatrix);
    gl.uniform4fv(shader.u_color, layerStyle.color || [0, 0, 0, 0]);

    if (!imagePos) {
        var diameter = layerStyle.radius * 2.0 * window.devicePixelRatio || 8.0 * window.devicePixelRatio;
        gl.uniform1f(shader.u_size, diameter);
        gl.uniform1f(shader.u_blur, layerStyle.blur / diameter || 1.5 / diameter);

        gl.vertexAttribPointer(shader.a_pos, 4, gl.SHORT, false, 16, 0);

        gl.drawArrays(gl.POINTS, begin, count);

    } else {
        gl.uniform1i(shader.u_invert, layerStyle.invert);
        gl.uniform2fv(shader.u_size, imagePos.size);
        gl.uniform2fv(shader.u_tl, imagePos.tl);
        gl.uniform2fv(shader.u_br, imagePos.br);
        gl.uniform1f(shader.u_zoom, (painter.transform.z - params.z) * 10.0);

        var rotate = layerStyle.alignment === 'line';
        gl.uniformMatrix2fv(shader.u_rotationmatrix, false, rotate ? painter.rotationMatrix : painter.identityMat2);

        // if icons are drawn rotated, or of the map is rotating use linear filtering for textures
        imageSprite.bind(gl, rotate || params.rotating || params.zooming);

        gl.vertexAttribPointer(shader.a_pos, 4, gl.SHORT, false, 16, 0);
        gl.vertexAttribPointer(shader.a_angle, 1, gl.BYTE, false, 16, 13);
        gl.vertexAttribPointer(shader.a_minzoom, 1, gl.BYTE, false, 16, 10);

        gl.drawArrays(gl.POINTS, begin, count);
    }

    stats.lines += count;
};
