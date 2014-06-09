'use strict';

var reference = require('./reference.js');

module.exports = CalculatedStyle;

addDefaultValues();

function CalculatedStyle() {}

function addDefaultValues() {
    var style = reference.style;
    for (var prop in style) {
        var value = style[prop]['default-value'];
        if (value !== undefined) {
            CalculatedStyle.prototype[prop] = value;
        }
    }
}
