/*jslint node: true */
"use strict";
var _ = require('lodash');
var async = require('async');
var storage = require('./storage.js');
var kvstore = require('./kvstore.js');
var archiving = require('./archiving.js');
var db = require('./db.js');
var constants = require("./constants.js");
var objectHash = require("./object_hash.js");
var mutex = require('./mutex.js');
var conf = require('./conf.js');
var breadcrumbs = require('./breadcrumbs.js');


var assocKnownBadJoints = {};
var assocKnownBadUnits = {};
var assocUnhandledUnits = {};


function checkIfNewUnit(unit, callbacks) {
	if (storage.isKnownUnit(unit))
		return callbacks.ifKnown();
	if (assocUnhandledUnits[unit])
		return callbacks.ifKnownUnverified();
	var error = assocKnownBadUnits[unit];
	if (error)
		return callbacks.ifKnownBad(error);
	db.query("SELECT sequence, main_chain_index FROM units WHERE unit=?", [unit], function(rows){
		if (rows.length > 0){
			var row = rows[0];
			if (row.sequence === 'final-bad' && row.main_chain_index !== null && row.main_chain_index < storage.getMinRetrievableMci()) // already stripped
				return callbacks.ifNew();
			storage.setUnitIsKnown(unit);
			return callbacks.ifKnown();
		}
		callbacks.ifNew();
	});
}

function checkIfNewJoint(objJoint, callbacks) {
	checkIfNewUnit(objJoint.unit.unit, {
		ifKnown: callbacks.ifKnown,
		ifKnownUnverified: callbacks.ifKnownUnverified,
		ifKnownBad: callbacks.ifKnownBad,
		ifNew: function(){
			var error = assocKnownBadJoints[objectHash.getJointHash(objJoint)];
			error ? callbacks.ifKnownBad(error) : callbacks.ifNew();
		}
	});
}


function removeUnhandledJointAndDependencies(unit, onDone){
	db.takeConnectionFromPool(function(conn){
		var arrQueries = [];
		conn.addQuery(arrQueries, "BEGIN");
		conn.addQuery(arrQueries, "DELETE FROM unhandled_joints WHERE unit=?", [unit]);
		conn.addQuery(arrQueries, "DELETE FROM dependencies WHERE unit=?", [unit]);
		conn.addQuery(arrQueries, "COMMIT");
		async.series(arrQueries, function(){
			delete assocUnhandledUnits[unit];
			conn.release();
			if (onDone)
				onDone();
		});
	});
}

function saveUnhandledJointAndDependencies(objJoint, arrMissingParentUnits, peer, onDone){
	var unit = objJoint.unit.unit;
	assocUnhandledUnits[unit] = true;
	db.takeConnectionFromPool(function(conn){
		var sql = "INSERT "+conn.getIgnore()+" INTO dependencies (unit, depends_on_unit) VALUES " + arrMissingParentUnits.map(function(missing_unit){
			return "("+conn.escape(unit)+", "+conn.escape(missing_unit)+")";
		}).join(", ");
		var arrQueries = [];
		conn.addQuery(arrQueries, "BEGIN");
		conn.addQuery(arrQueries, "INSERT "+conn.getIgnore()+" INTO unhandled_joints (unit, json, peer) VALUES (?, ?, ?)", [unit, JSON.stringify(objJoint), peer]);
		conn.addQuery(arrQueries, sql);
		conn.addQuery(arrQueries, "COMMIT");
		async.series(arrQueries, function(){
			conn.release();
			if (onDone)
				onDone();
		});
	});
}


// handleDependentJoint called for each dependent unit
function readDependentJointsThatAreReady(unit, handleDependentJoint){
	//console.log("readDependentJointsThatAreReady "+unit);
	var t=Date.now();
	var from = unit ? "FROM dependencies AS src_deps JOIN dependencies USING(unit)" : "FROM dependencies";
	var where = unit ? "WHERE src_deps.depends_on_unit="+db.escape(unit) : "";
	var lock = unit ? mutex.lock : mutex.lockOrSkip;
	lock(["dependencies"], function(unlock){
		db.query(
			"SELECT dependencies.unit, unhandled_joints.unit AS unit_for_json, \n\
				SUM(CASE WHEN units.unit IS NULL THEN 1 ELSE 0 END) AS count_missing_parents \n\
			"+from+" \n\
			JOIN unhandled_joints ON dependencies.unit=unhandled_joints.unit \n\
			LEFT JOIN units ON dependencies.depends_on_unit=units.unit \n\
			"+where+" \n\
			GROUP BY dependencies.unit \n\
			HAVING count_missing_parents=0 \n\
			ORDER BY NULL", 
			function(rows){
				//console.log(rows.length+" joints are ready");
				//console.log("deps: "+(Date.now()-t));
				rows.forEach(function(row) {
					db.query("SELECT json, peer, "+db.getUnixTimestamp("creation_date")+" AS creation_ts FROM unhandled_joints WHERE unit=?", [row.unit_for_json], function(internal_rows){
						internal_rows.forEach(function(internal_row) {
							handleDependentJoint(JSON.parse(internal_row.json), parseInt(internal_row.creation_ts), internal_row.peer);
						});
					});
				});
				unlock();
			}
		);
	});
}

function findLostJoints(handleLostJoints){
	//console.log("findLostJoints");
	mutex.lockOrSkip(['findLostJoints'], function (unlock) {
		db.query(
			"SELECT DISTINCT depends_on_unit \n\
			FROM dependencies \n\
			LEFT JOIN unhandled_joints ON depends_on_unit=unhandled_joints.unit \n\
			LEFT JOIN units ON depends_on_unit=units.unit \n\
			WHERE unhandled_joints.unit IS NULL AND units.unit IS NULL AND dependencies.creation_date < " + db.addTime("-8 SECOND"),
			function (rows) {
				//console.log(rows.length+" lost joints");
				unlock();
				if (rows.length === 0)
					return;
				handleLostJoints(rows.map(function (row) { return row.depends_on_unit; }));
			}
		);
	});
}

// onPurgedDependentJoint called for each purged dependent unit
function purgeJointAndDependencies(objJoint, error, onPurgedDependentJoint, onDone){
	var unit = objJoint.unit.unit;
	assocKnownBadUnits[unit] = error;
	db.takeConnectionFromPool(function(conn){
		var arrQueries = [];
		conn.addQuery(arrQueries, "BEGIN");
		conn.addQuery(arrQueries, "INSERT "+conn.getIgnore()+" INTO known_bad_joints (unit, json, error) VALUES (?,?,?)", [unit, JSON.stringify(objJoint), error]);
		conn.addQuery(arrQueries, "DELETE FROM unhandled_joints WHERE unit=?", [unit]); // if any
		conn.addQuery(arrQueries, "DELETE FROM dependencies WHERE unit=?", [unit]);
		collectQueriesToPurgeDependentJoints(conn, arrQueries, unit, error, onPurgedDependentJoint, function(){
			conn.addQuery(arrQueries, "COMMIT");
			async.series(arrQueries, function(){
				delete assocUnhandledUnits[unit];
				conn.release();
				if (onDone)
					onDone();
			})
		});
	});
}

// onPurgedDependentJoint called for each purged dependent unit
function purgeDependencies(unit, error, onPurgedDependentJoint, onDone){
	db.takeConnectionFromPool(function(conn){
		var arrQueries = [];
		conn.addQuery(arrQueries, "BEGIN");
		collectQueriesToPurgeDependentJoints(conn, arrQueries, unit, error, onPurgedDependentJoint, function(){
			conn.addQuery(arrQueries, "COMMIT");
			async.series(arrQueries, function(){
				conn.release();
				if (onDone)
					onDone();
			})
		});
	});
}

// onPurgedDependentJoint called for each purged dependent unit
function collectQueriesToPurgeDependentJoints(conn, arrQueries, unit, error, onPurgedDependentJoint, onDone){
	conn.query("SELECT unit, peer FROM dependencies JOIN unhandled_joints USING(unit) WHERE depends_on_unit=?", [unit], function(rows){
		if (rows.length === 0)
			return onDone();
		//conn.addQuery(arrQueries, "DELETE FROM dependencies WHERE depends_on_unit=?", [unit]);
		var arrUnits = rows.map(function(row) { return row.unit; });
		arrUnits.forEach(function(dep_unit){
			assocKnownBadUnits[dep_unit] = error;
			delete assocUnhandledUnits[dep_unit];
		});
		conn.addQuery(arrQueries, "INSERT "+conn.getIgnore()+" INTO known_bad_joints (unit, json, error) \n\
			SELECT unit, json, ? FROM unhandled_joints WHERE unit IN(?)", [error, arrUnits]);
		conn.addQuery(arrQueries, "DELETE FROM unhandled_joints WHERE unit IN(?)", [arrUnits]);
		conn.addQuery(arrQueries, "DELETE FROM dependencies WHERE unit IN(?)", [arrUnits]);
		async.eachSeries(
			rows,
			function(row, cb){
				if (onPurgedDependentJoint)
					onPurgedDependentJoint(row.unit, row.peer);
				collectQueriesToPurgeDependentJoints(conn, arrQueries, row.unit, error, onPurgedDependentJoint, cb);
			},
			onDone
		);
	});
}

function purgeUncoveredNonserialJointsUnderLock(){
	mutex.lockOrSkip(["purge_uncovered"], function(unlock){
		mutex.lock(["handleJoint"], function(unlock_hj){
			purgeUncoveredNonserialJoints(false, function(){
				unlock_hj();
				unlock();
			});
		});
	});
}

function purgeUncoveredNonserialJoints(bByExistenceOfChildren, onDone){
	var cond = bByExistenceOfChildren ? "(SELECT 1 FROM parenthoods WHERE parent_unit=unit LIMIT 1) IS NULL" : "is_free=1";
	var order_column = (conf.storage === 'mysql') ? 'creation_date' : 'rowid'; // this column must be indexed!
	var byIndex = (bByExistenceOfChildren && conf.storage === 'sqlite') ? 'INDEXED BY bySequence' : '';
	// the purged units can arrive again, no problem
	db.query( // purge the bad ball if we've already received at least 7 witnesses after receiving the bad ball
		"SELECT unit FROM units "+byIndex+" \n\
		WHERE "+cond+" AND sequence IN('final-bad','temp-bad') AND content_hash IS NULL \n\
			AND NOT EXISTS (SELECT * FROM dependencies WHERE depends_on_unit=units.unit) \n\
			AND NOT EXISTS (SELECT * FROM balls WHERE balls.unit=units.unit) \n\
			AND (units.creation_date < "+db.addTime('-10 SECOND')+" OR EXISTS ( \n\
				SELECT DISTINCT address FROM units AS wunits CROSS JOIN unit_authors USING(unit) CROSS JOIN my_witnesses USING(address) \n\
				WHERE wunits."+order_column+" > units."+order_column+" \n\
				LIMIT 0,1 \n\
			)) \n\
			/* AND NOT EXISTS (SELECT * FROM unhandled_joints) */ \n\
		ORDER BY units."+order_column+" DESC", 
		// some unhandled joints may depend on the unit to be archived but it is not in dependencies because it was known when its child was received
	//	[constants.MAJORITY_OF_WITNESSES - 1],
		function(rows){
			if (rows.length === 0)
				return onDone();
			mutex.lock(["write"], function(unlock) {
				db.takeConnectionFromPool(function (conn) {
					async.eachSeries(
						rows,
						function (row, cb) {
							breadcrumbs.add("--------------- archiving uncovered unit " + row.unit);
							storage.readJoint(conn, row.unit, {
								ifNotFound: function () {
									throw Error("nonserial unit not found?");
								},
								ifFound: function (objJoint) {
									var arrQueries = [];
									conn.addQuery(arrQueries, "BEGIN");
									archiving.generateQueriesToArchiveJoint(conn, objJoint, 'uncovered', arrQueries, function(){
										conn.addQuery(arrQueries, "COMMIT");
										// sql goes first, deletion from kv is the last step
										async.series(arrQueries, function(){
											kvstore.del('j\n'+row.unit, function(){
												breadcrumbs.add("------- done archiving "+row.unit);
												var parent_units = storage.assocUnstableUnits[row.unit].parent_units;
												storage.forgetUnit(row.unit);
												storage.fixIsFreeAfterForgettingUnit(parent_units);
												cb();
											});
										});
									});
								}
							});
						},
						function () {
							conn.query(
								"UPDATE units SET is_free=1 WHERE is_free=0 AND is_stable=0 \n\
								AND (SELECT 1 FROM parenthoods WHERE parent_unit=unit LIMIT 1) IS NULL",
								function () {
									conn.release();
									unlock();
									if (rows.length > 0)
										return purgeUncoveredNonserialJoints(false, onDone); // to clean chains of bad units
									onDone();
								}
							);
						}
					);
				});
			});
		}
	);
}

// handleJoint is called for every joint younger than mci
function readJointsSinceMci(mci, handleJoint, onDone){
	db.query(
		"SELECT units.unit FROM units LEFT JOIN archived_joints USING(unit) \n\
		WHERE (is_stable=0 AND main_chain_index>=? OR main_chain_index IS NULL OR is_free=1) AND archived_joints.unit IS NULL \n\
		ORDER BY +level", 
		[mci], 
		function(rows){
			async.eachSeries(
				rows, 
				function(row, cb){
					storage.readJoint(db, row.unit, {
						ifNotFound: function(){
						//	throw Error("unit "+row.unit+" not found");
							breadcrumbs.add("unit "+row.unit+" not found");
							cb();
						},
						ifFound: function(objJoint){
							handleJoint(objJoint);
							cb();
						}
					});
				},
				onDone
			);
		}
	);
}

function saveKnownBadJoint(objJoint, error, onDone){
	var joint_hash = objectHash.getJointHash(objJoint);
	assocKnownBadJoints[joint_hash] = error;
	db.query(
		"INSERT "+db.getIgnore()+" INTO known_bad_joints (joint, json, error) VALUES (?,?,?)",
		[joint_hash, JSON.stringify(objJoint), error],
		function(){
			onDone();
		}
	);
}

function purgeOldUnhandledJoints(){
	db.query("SELECT unit FROM unhandled_joints WHERE creation_date < "+db.addTime("-1 HOUR"), function(rows){
		if (rows.length === 0)
			return;
		var arrUnits = rows.map(function(row){ return row.unit; });
		arrUnits.forEach(function(unit){
			delete assocUnhandledUnits[unit];
		});
		var strUnitsList = arrUnits.map(db.escape).join(', ');
		db.query("DELETE FROM dependencies WHERE unit IN("+strUnitsList+")");
		db.query("DELETE FROM unhandled_joints WHERE unit IN("+strUnitsList+")");
	});
}

function initUnhandledAndKnownBad(){
	db.query("SELECT unit FROM unhandled_joints", function(rows){
		rows.forEach(function(row){
			assocUnhandledUnits[row.unit] = true;
		});
		db.query("SELECT unit, joint, error FROM known_bad_joints ORDER BY creation_date DESC LIMIT 1000", function(rows){
			rows.forEach(function(row){
				if (row.unit)
					assocKnownBadUnits[row.unit] = row.error;
				if (row.joint)
					assocKnownBadJoints[row.joint] = row.error;
			});
		});
	});
}


exports.saveKnownBadJoint = saveKnownBadJoint;
exports.initUnhandledAndKnownBad = initUnhandledAndKnownBad;

exports.checkIfNewUnit = checkIfNewUnit;
exports.checkIfNewJoint = checkIfNewJoint;

exports.saveUnhandledJointAndDependencies = saveUnhandledJointAndDependencies;
exports.removeUnhandledJointAndDependencies = removeUnhandledJointAndDependencies;
exports.readDependentJointsThatAreReady = readDependentJointsThatAreReady;
exports.findLostJoints = findLostJoints;
exports.purgeJointAndDependencies = purgeJointAndDependencies;
exports.purgeDependencies = purgeDependencies;
exports.purgeUncoveredNonserialJointsUnderLock = purgeUncoveredNonserialJointsUnderLock;
exports.purgeOldUnhandledJoints = purgeOldUnhandledJoints;
exports.readJointsSinceMci = readJointsSinceMci;
