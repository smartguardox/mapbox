uniform sampler2D u_image0;
varying vec2 v_pos0;

#ifdef FOG
varying vec3 v_fog_pos;
#endif

void main() {
    vec4 color = texture2D(u_image0, v_pos0);
#ifdef FOG
    color.rgb = fog_dither(fog_apply(color.rgb, v_fog_pos));
#endif
    gl_FragColor = color;
#ifdef TERRAIN_WIREFRAME
    gl_FragColor = vec4(1.0, 0.0, 0.0, 0.8);
#endif
#ifdef OVERDRAW_INSPECTOR
    gl_FragColor = vec4(1.0);
#endif
}
