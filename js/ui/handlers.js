'use strict';

var Interaction = require('./interaction');
var util = require('../util/util');

module.exports = Handlers;

function Handlers(map) {

    var startScale, startBearing,
        inertiaLinearity = 0.2,
        inertiaEasing = util.bezier(0, 0, inertiaLinearity, 1);

    this.interaction = new Interaction(map.getCanvas())
        .on('click', function(e) {
            e.latLng = map.unproject(e.point);
            map.fire('click', e);
        })
        .on('dblclick', function(e) {
            e.latLng = map.unproject(e.point);
            map.fire('dblclick', e);
        })
        .on('mousemove', function(e) {
            e.latLng = map.unproject(e.point);
            map.fire('mousemove', e);
        })
        .on('down', function() {
            map.fire('movestart');
        })
        .on('resize', function() {
            map.stop();
            map.resize();
            map.update();
        })
        .on('keydown', function(e) {
            if (e.altKey || e.ctrlKey || e.metaKey) return;

            var pan = 80;
            var rotate = 2;

            function zoomBy(z) {
                map.zoomTo(Math.round(map.getZoom()) + (e.shiftKey ? 2 : 1) * z);
            }

            function panBy(v) {
                map.panBy(v);
            }

            function rotateBy(v) {
                map.setBearing(map.getBearing() + v);
            }

            switch (e.keyCode) {
                case 61:
                case 107:
                case 171:
                case 187:
                    zoomBy(1);
                    break;
                case 189:
                case 109:
                case 173:
                    zoomBy(-1);
                    break;
                case 37:
                    if (e.shiftKey) {
                        rotateBy(-rotate);
                    } else {
                        panBy([-pan, 0]);
                    }
                    break;
                case 39:
                    if (e.shiftKey) {
                        rotateBy(rotate);
                    } else {
                        panBy([pan, 0]);
                    }
                    break;
                case 38:
                    panBy([0, -pan]);
                    break;
                case 40:
                    panBy([0, pan]);
                    break;
                default:
                    return;
            }
        })
        .on('pan', function(e) {
            map.stop();
            var mouseLocation = map.transform.pointLocation(e.point.add(e.offset));
            map.transform.setLocationAtPoint(mouseLocation, e.point);
            map.fire('move');
        })
        .on('panend', function(e) {
            if (!e.inertia) {
                map.fire('moveend');
            } else {
                // convert velocity to px/s & adjust for increased initial animation speed when easing out
                var velocity = e.inertia.mult(1000 * inertiaLinearity),
                    speed = velocity.mag();

                var maxSpeed = 4000; // px/s

                if (speed >= maxSpeed) {
                    speed = maxSpeed;
                    velocity._unit()._mult(maxSpeed);
                }

                var deceleration = 8000, // px/s^2
                    duration = speed / (deceleration * inertiaLinearity),
                    offset = velocity.mult(-duration / 2).round();

                map.panBy(offset, {
                    duration: duration * 1000,
                    easing: inertiaEasing,
                    noMoveStart: true
                });
            }
        })
        .on('zoom', function(e) {
            // Scale by sigmoid of scroll wheel delta.
            var scale = 2 / (1 + Math.exp(-Math.abs(e.delta / 100)));
            if (e.delta < 0 && scale !== 0) scale = 1 / scale;

            var fromScale = map.ease && isFinite(e.delta) ? map.ease.to : map.transform.scale,
                duration = !isFinite(e.delta) ? 800 : 0,
                targetZoom = map.transform.scaleZoom(fromScale * scale);

            map.zoomTo(targetZoom, {
                duration: duration,
                around: map.unproject(e.point)
            });
        })
        .on('pinchstart', function() {
            startScale = map.transform.scale;
            startBearing = map.transform.bearing;
        })
        .on('pinch', function(e) {
            map.easeTo({
                zoom: map.transform.scaleZoom(startScale * e.scale),
                bearing: startBearing + e.bearing,
                duration: 0,
                around: map.unproject(e.point)
            });
        });
}
