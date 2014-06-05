'use strict';
var test = require('tape').test;

var filter = require('../js/style/bucket-filter.js');

function createFilter(json) {
	return filter({filter: json});
}

test('bucketFilter', function(t) {
	t.test('filters by all properties in the root', function (t) {

		var f = createFilter({foo: 'bar', bar: 5});

		t.equal(typeof f, 'function');
		t.ok(f({foo: 'bar', bar: 5, z: 5}));
		t.end();
	});

	t.test('returns undefined if no filter specified', function (t) {

		var f = filter({});

		t.equal(typeof f, 'undefined');
		t.end();
	});

	t.test('matches of the values if array is specified', function (t) {

		var f = createFilter({foo: ['bar', 'baz']});

		t.ok(f({foo: 'bar', z: 5}));
		t.ok(f({foo: 'baz', z: 5}));
		t.end();
	});

	t.test('doesn\'t filter if one of the fields doesn\'t match', function (t) {

		var f = createFilter({foo: 'bar', bar: 5});

		t.notOk(f({foo: 'bar', z: 5}));
		t.end();
	});
});
