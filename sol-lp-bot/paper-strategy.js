"use strict";
// System-configurable v1: strategy-geometry defaults come from the active
// warlock-config profile when it loads; the literals after ?? are the
// fallback for a standalone run without the config file.
let CONFIG_PROFILE = null;
try { CONFIG_PROFILE = require('./config-loader').loadConfig().profile; } catch { /* keep literal defaults */ }
const CPV = (dotted, fallback) => { const v = dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), CONFIG_PROFILE || {}); return v === undefined ? fallback : v; };
const DEFAULTS={QUOTE_FAILURE_POLLS:CPV('exits.quoteFailurePolls',10),RANGE_DOWN_PCT:CPV('geometry.rangeDownPct',50),LOWER_BINS:CPV('geometry.lowerBins',0),RANGE_UP_PCT:CPV('geometry.rangeUpPct',0),OPEN_SHAPE:CPV('geometry.openShape','MIXED'),OPEN_SPOT_PCT:CPV('geometry.openSpotPct',50),RESHAPE_ENABLED:CPV('reshape.reshapeEnabled',true),COMPOUND_ENABLED:CPV('reshape.compoundEnabled',true),COMPOUND_SPOT_PCT:CPV('geometry.compoundSpotPct',50),RESHAPE_SHAPE:CPV('geometry.reshapeShape','BIDASK'),MAX_POSITION_TVL_PCT:CPV('geometry.maxPositionTvlPct',5)};
const KEYS=[...Object.keys(DEFAULTS),'UPPER_BUFFER_BINS','RESHAPE_N','TP','TP_USD_PCT','OOR_RIGHT_CLOSE','OOR_RIGHT_CONFIRM_POLLS','OOR_RIGHT_MIN_BINS','OOR_RIGHT_REPOSITION_MIN_PNL_PCT','OOR_RIGHT_MIN_PROFIT_PCT','OOR_RIGHT_MAX_REPOSITIONS','TRAIL_ENABLED','TRAIL_ARM_PCT','TRAIL_DROP_PCT','OOR_MAX_MIN','EMERGENCY_DROP','MAX_HOURS','GAS_BUFFER_SOL',
// Batch 1 (Window 2, 21 Nov 2026): exit-policy keys a per-variant stamp must carry, otherwise
// paper-exit-policy.decide() (which reads {...CFG, ...pos.strategySettings}) would silently fall
// back to the global CFG for that variant. RESHAPE_MAX is new: freeze reshaping once
// pos.reshapes reaches it (arm E = 5); absent = unlimited (control behaviour).
'EMERGENCY_TP_ENABLED','EMERGENCY_TP_TRIGGER_RANGE_PCT','EMERGENCY_TP_PCT',
'EMERGENCY_SLPLUS_ENABLED','EMERGENCY_SLPLUS_ARM_PCT','EMERGENCY_SLPLUS_LOCK_PCT','EMERGENCY_SLPLUS_CONFIRM_POLLS','EMERGENCY_SLPLUS_FLOOR_PCT','EMERGENCY_SLPLUS_FLOOR_POLLS',
'RESHAPE_MAX'];
function snapshot(c){return Object.fromEntries(KEYS.filter(k=>c[k]!==undefined||DEFAULTS[k]!==undefined).map(k=>[k,c[k]??DEFAULTS[k]]));}
function geometry(step,c,max=1400){const base=1+step/1e4,upper=c.RANGE_UP_PCT>0?Math.ceil(Math.log(1+c.RANGE_UP_PCT/100)/Math.log(base)):(c.UPPER_BUFFER_BINS??0);const n=Math.min(max-1-upper,c.LOWER_BINS>0?c.LOWER_BINS:Math.ceil(Math.log(1/(1-(c.RANGE_DOWN_PCT??50)/100))/Math.log(base)));if(!(n>=1&&upper>=0&&n+upper<=max))throw Error('Range/bin count exceeds SDK limit');return {n,upper,bins:n+upper,downPct:(1-Math.pow(base,-n))*100,lowerBinPricePct:(1-Math.pow(base,1-n))*100,upPct:(Math.pow(base,upper)-1)*100};}
function skip(g){return g.bins>=50&&g.downPct>=49-1e-9;}
function reason(g){return `MAX_NONREFUND_SOL dilewati: ${g.bins} bin, coverage bawah ${g.downPct.toFixed(2)}% memenuhi target 50% (toleransi pembulatan 49%); tanpa menunggu RPC rent (biaya tetap dihitung)`;}
module.exports={DEFAULTS,KEYS,snapshot,geometry,skip,reason};
