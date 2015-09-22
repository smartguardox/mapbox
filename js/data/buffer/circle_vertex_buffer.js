'use strict';

var util = require('../../util/util');
var Buffer = require('../buffer');

function CircleVertexBuffer(options) {
    Buffer.call(this, options || {
        type: Buffer.BufferType.VERTEX,
        attributes: [{
            name: 'pos',
            components: 2,
            type: Buffer.AttributeType.SHORT
        }]
    });
}

CircleVertexBuffer.prototype = util.inherit(Buffer, {
    add: function(x, y, extrudeX, extrudeY) {
        this.push(
            (x * 2) + ((extrudeX + 1) / 2),
            (y * 2) + ((extrudeY + 1) / 2));
    },
    bind: function(gl, shader, offset) {
        Buffer.prototype.bind.call(this, gl);

        gl.vertexAttribPointer(shader.a_pos, 2,
            gl.SHORT, false,
            this.itemSize, offset + 0);
    }
});

module.exports = CircleVertexBuffer;
