#define root2 1.42
precision mediump float;

uniform sampler2D u_image;
uniform vec4 u_color;
uniform bool u_invert;

varying mat2 v_rotationmatrix;
varying vec2 v_tl;
varying vec2 v_br;

void main(void) {
    vec2 pos = v_rotationmatrix * (gl_PointCoord * 2.0 - 1.0) * root2 / 2.0 + 0.5;

    float inbounds = step(0.0, pos.x) * step(0.0, pos.y) *
        (1.0 - step(1.0, pos.x)) * (1.0 - step(1.0, pos.y));

    vec4 color = texture2D(u_image, mix(v_tl, v_br, pos)) * inbounds;
    if (u_invert) {
        color.rgb = 1.0 - color.rgb;
    }

    if (u_color.a > 0.0) {
        gl_FragColor = u_color * color;
    } else {
        gl_FragColor = vec4(color.rgb * color.a, color.a);
    }
}
