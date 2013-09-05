function Interaction(el) {
    var handlers = {};
    this.handlers = handlers;
    var rotationKey = false,
        rotating = false,
        firstPos = null,
        pos = null,
        offsetLeft = el.offsetLeft,
        offsetTop = el.offsetTop;

    document.addEventListener('keydown', onkeydown, false);
    document.addEventListener('keyup', onkeyup, false);
    el.addEventListener('mousedown', onmousedown, false);
    document.addEventListener('mouseup', onmouseup, false);
    document.addEventListener('mousemove', onmousemove, false);
    el.addEventListener('click', onclick, false);
    el.addEventListener(/Firefox/i.test(navigator.userAgent) ? 'DOMMouseScroll' : 'mousewheel', onmousewheel, false);
    el.addEventListener('dblclick', ondoubleclick, false);
    window.addEventListener('resize', resize, false);

    function zoom(delta, x, y) {
        if (!handlers.zoom) return;
        for (var i = 0; i < handlers.zoom.length; i++) {
            handlers.zoom[i](delta, x - offsetLeft, y - offsetTop);
        }
    }

    function click(x, y) {
        if (!handlers.click) return;
        for (var i = 0; i < handlers.click.length; i++) {
            handlers.click[i](x - offsetLeft, y - offsetTop);
        }
    }

    function pan(x, y) {
        if (pos && handlers.pan) {
            for (var i = 0; i < handlers.pan.length; i++) {
                handlers.pan[i](x - pos.x, y - pos.y);
            }
            pos = { x: x, y: y };
        }
    }

    function resize() {
        if (!handlers.resize) return;
        for (var i = 0; i < handlers.resize.length; i++) {
            handlers.resize[i]();
        }
        offsetLeft = el.offsetLeft;
    }

    function rotate(x, y) {
        if (pos && handlers.rotate) {
            for (var i = 0; i < handlers.rotate.length; i++) {
                handlers.rotate[i]([firstPos.x, firstPos.y], [ pos.x, pos.y ], [ x, y ]);
            }
            pos = { x: x, y: y };
        }
    }

    function onkeydown(ev) {
        if (ev.keyCode == 18) {
            rotating = rotationKey = true;
        }
    }

    function onkeyup(ev) {
        if (ev.keyCode == 18) {
            rotationKey = false;
        }
    }

    function onmousedown(ev) {
        if (!rotationKey) {
            rotating = false;
        }
        firstPos = pos = { x: ev.pageX, y: ev.pageY };
    }

    function onmouseup() {
        if (!rotationKey) {
            rotating = false;
        }
        pos = null;
    }

    function onmousemove(ev) {
        if (rotating) {
            rotate(ev.pageX, ev.pageY);
        } else {
            pan(ev.pageX, ev.pageY);
        }
    }

    function onclick(ev) {
        click(ev.pageX, ev.pageY);
    }

    function onmousewheel(ev) {
        zoom(ev.wheelDeltaY || (ev.detail * -120), ev.pageX, ev.pageY);
        ev.preventDefault();
    }

    function ondoubleclick(ev) {
        zoom(Infinity, ev.pageX, ev.pageY);
        ev.preventDefault();
    }
}

Interaction.prototype.on = function(ev, fn) {
    if (!this.handlers[ev]) this.handlers[ev] = [];
    this.handlers[ev].push(fn);
    return this;
};
