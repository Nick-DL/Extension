/**
 * ===================================================================
 * 排班核心算法模块 — 纯函数设计 (浏览器扩展版本)
 * ===================================================================
 * 从示例网页 js/algorithm.js 移植，保持完整一致性。
 * 在 Content Script 隔离环境中运行。
 */
const ScheduleAlgorithm = (function () {
  'use strict';

  const SCHEDULE_TYPES = [
    '产假', '事假', '休', '夜休', '年休假', '值班', '二线', '培训', '进修(血液)',
    '白班普', '白班1', '中班', '梓潼门诊', '高新门诊', '总院门诊', '开会.', '医疗保障', '脱产学习'
  ];

  const TYPE_COLORS = {
    '产假': '#ff6b6b', '事假': '#ff8787', '休': '#d9d9d9', '夜休': '#b0bec5',
    '值班': '#ff9800', '二线': '#ffc107', '培训': '#4caf50', '白班普': '#2196f3',
    '白班1': '#9c27b0', '中班': '#ff5722', '梓潼门诊': '#00bcd4',
    '高新门诊': '#009688', '总院门诊': '#3f51b5', '开会.': '#795548', '医疗保障': '#607d8b',
    '脱产学习': '#546e7a', '年休假': '#90a4ae', '进修(血液)': '#26a06c'
  };

  const SPECIAL_TYPES = ['产假', '事假', '休', '年休假', '二线', '培训', '进修(血液)', '开会.', '医疗保障', '脱产学习'];
  const CLINIC_TYPES = ['总院门诊', '高新门诊', '梓潼门诊'];
  const DUTY_TYPES = ['中班', '值班', '夜休'];
  const HOLIDAY_FORBIDDEN = ['白班普', '白班1', '中班'];
  const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const SLOTS = ['am', 'pm'];
  const SLOT_LABELS = { am: '上午', pm: '下午' };

  function cloneDutyAssigned(dutyAssigned) {
    const copy = {};
    for (const docId in dutyAssigned) {
      copy[docId] = {};
      for (const d in dutyAssigned[docId]) {
        const slot = dutyAssigned[docId][d];
        copy[docId][d] = { am: slot.am, pm: slot.pm };
      }
    }
    return copy;
  }

  function ensureDutySlot(dutyAssigned, docId, dayIdx) {
    if (!dutyAssigned[docId]) dutyAssigned[docId] = {};
    if (!dutyAssigned[docId][dayIdx]) dutyAssigned[docId][dayIdx] = { am: null, pm: null };
  }

  function isWeekend(dayIdx) { return dayIdx >= 5; }
  function isHoliday(workdayConfig, dayIdx) { return !(workdayConfig || [])[dayIdx]; }
  function getDoctor(doctors, id) { return doctors.find(d => d.id === id); }

  function getSlotSchedule(state, doctorId, dayIdx, slot) {
    const { special, dutyAssigned, outpatientGeneral, outpatientSimple, outpatientGaoxin, outpatientZitong } = state;
    const spec = (special || {})[doctorId];
    if (spec && spec[dayIdx] && spec[dayIdx][slot]) return spec[dayIdx][slot];
    const duty = (dutyAssigned || {})[doctorId];
    if (duty && duty[dayIdx] && duty[dayIdx][slot]) return duty[dayIdx][slot];
    const genDay = (outpatientGeneral || {})[dayIdx];
    if (genDay && genDay[slot] === doctorId) return '总院门诊';
    if ((outpatientSimple || []).some(a => a.dayIdx === dayIdx && a.doctorId === doctorId && a.slot === slot)) return '总院门诊';
    if (slot === 'am') {
      if ((outpatientGaoxin || []).some(a => a.dayIdx === dayIdx && a.doctorId === doctorId)) return '高新门诊';
      if ((outpatientZitong || []).some(a => a.dayIdx === dayIdx && a.doctorId === doctorId)) return '梓潼门诊';
    }
    return null;
  }

  function getDoctorWeekSchedule(state, doctorId) {
    const { workdayConfig } = state;
    const result = {};
    for (let d = 0; d < 7; d++) {
      result[d] = { am: getSlotSchedule(state, doctorId, d, 'am'), pm: getSlotSchedule(state, doctorId, d, 'pm') };
    }
    for (let d = 0; d < 7; d++) {
      if (isHoliday(workdayConfig, d)) {
        for (let s of SLOTS) {
          if (HOLIDAY_FORBIDDEN.includes(result[d][s])) result[d][s] = '休';
        }
      }
    }
    return result;
  }

  function getDutyDoctorPool(doctors) {
    return doctors.filter(d => {
      if (d.type === 'director' || d.type === 'trainee') return false;
      if (d.training) return false;
      if (d.onLeave) return false;
      return true;
    });
  }

  function getDutyEligibleDoctors(doctors) {
    return getDutyDoctorPool(doctors);
  }

  function getBaiban1Candidates(state, dayIdx, slot) {
    const candidates = [];
    for (let doc of state.doctors) {
      if (doc.type === 'director' || doc.type === 'trainee') continue;
      const existing = getSlotSchedule(state, doc.id, dayIdx, slot);
      if (existing && (DUTY_TYPES.includes(existing) || CLINIC_TYPES.includes(existing) || SPECIAL_TYPES.includes(existing))) continue;
      candidates.push(doc);
    }
    return candidates;
  }

  function buildDefaultDutyOrder(doctors) {
    const pool = getDutyDoctorPool(doctors);
    const order = [];
    for (let i = 0; i < 8; i++) {
      const doc = pool[i % pool.length];
      order.push(doc ? doc.id : (pool[0] ? pool[0].id : ''));
    }
    return order;
  }

  const DUTY_CYCLE_ZB_DAY = [null, null, 0, 1, 2, 3, 4, 5];
  const DUTY_CYCLES = [
    { zb: null, vb: null, yx: 0 },
    { zb: null, vb: 0, yx: 1 },
    { zb: 0, vb: 1, yx: 2 },
    { zb: 1, vb: 2, yx: 3 },
    { zb: 2, vb: 3, yx: 4 },
    { zb: 3, vb: 4, yx: 5 },
    { zb: 4, vb: 5, yx: 6 },
    { zb: 5, vb: 6, yx: null },
  ];

  function getDutyRowDesc(workdayConfig, index) {
    const baseDesc = [
      '(上周日值班)周一夜休', '周一值班·周二夜休', '周一中班·周二值班·周三夜休',
      '周二中班·周三值班·周四夜休', '周三中班·周四值班·周五夜休',
      '周四中班·周五值班·周六夜休', '周五中班·周六值班·周日夜休', '周六中班·周日值班',
    ];
    const zbDay = DUTY_CYCLE_ZB_DAY[index];
    let desc = baseDesc[index];
    if (zbDay !== null && isHoliday(workdayConfig, zbDay)) {
      desc = desc.replace(DAYS[zbDay] + '中班', DAYS[zbDay] + '休');
    }
    return desc;
  }

  function computeAutoDuty(state) {
    const { doctors, dutyOrder, workdayConfig, outpatientGeneral, outpatientGaoxin,
            outpatientZitong, special, cancelPreHolidayZhongban } = state;
    let newDuty = cloneDutyAssigned(state.dutyAssigned || {});
    let newFlags = [];
    const seq = (dutyOrder || []).filter(id => id && getDoctor(doctors, id));
    if (seq.length === 0) return { dutyAssigned: newDuty, baiban1Flags: newFlags };

    for (let i = 0; i < 8; i++) {
      const docId = seq[i];
      if (!docId || !getDoctor(doctors, docId)) continue;
      const cyc = DUTY_CYCLES[i];
      if (cyc.zb !== null && cyc.zb >= 0 && cyc.zb < 7) {
        const result = computeFillDayDuty({
          doctors, workdayConfig, outpatientGeneral, outpatientGaoxin,
          outpatientZitong, special, cancelPreHolidayZhongban,
          dutyAssigned: newDuty, baiban1Flags: newFlags
        }, docId, cyc.zb, '中班');
        newDuty = result.dutyAssigned; newFlags = result.baiban1Flags;
      }
      if (cyc.vb !== null && cyc.vb >= 0 && cyc.vb < 7) {
        const result = computeFillDayDuty({
          doctors, workdayConfig, outpatientGeneral, outpatientGaoxin,
          outpatientZitong, special, cancelPreHolidayZhongban,
          dutyAssigned: newDuty, baiban1Flags: newFlags
        }, docId, cyc.vb, '值班');
        newDuty = result.dutyAssigned; newFlags = result.baiban1Flags;
      }
      if (cyc.yx !== null && cyc.yx >= 0 && cyc.yx < 7) {
        const result = computeFillDayDuty({
          doctors, workdayConfig, outpatientGeneral, outpatientGaoxin,
          outpatientZitong, special, cancelPreHolidayZhongban,
          dutyAssigned: newDuty, baiban1Flags: newFlags
        }, docId, cyc.yx, '夜休');
        newDuty = result.dutyAssigned; newFlags = result.baiban1Flags;
      }
    }
    newDuty = computeHolidayRules(newDuty, workdayConfig);
    newFlags = computeConflicts({
      doctors, workdayConfig, outpatientGeneral, outpatientGaoxin,
      outpatientZitong, special,
      dutyAssigned: newDuty, baiban1Flags: newFlags
    });
    return { dutyAssigned: newDuty, baiban1Flags: newFlags };
  }

  function computeFillDayDuty(state, docId, dayIdx, type) {
    const { doctors, workdayConfig, outpatientGeneral, outpatientSimple, outpatientGaoxin,
            outpatientZitong, special, cancelPreHolidayZhongban } = state;
    let newDuty = cloneDutyAssigned(state.dutyAssigned || {});
    let newFlags = [...(state.baiban1Flags || [])];
    ensureDutySlot(newDuty, docId, dayIdx);

    for (let s of SLOTS) {
      const existSpec = ((special || {})[docId] || {})[dayIdx];
      if (existSpec && existSpec[s]) continue;
      const existDuty = newDuty[docId][dayIdx][s];
      const genDay = (outpatientGeneral || {})[dayIdx];
      const hasOutpatient = (genDay && genDay[s] === docId) || ((outpatientSimple || []).some(a => a.dayIdx === dayIdx && a.doctorId === docId && a.slot === s));
      const hasGaoxin = (outpatientGaoxin || []).some(a => a.dayIdx === dayIdx && a.doctorId === docId);
      const hasZitong = (outpatientZitong || []).some(a => a.dayIdx === dayIdx && a.doctorId === docId);

      if (type === '中班' && s === 'am' && hasOutpatient) continue;
      if (type === '中班' && s === 'am' && (hasGaoxin || hasZitong)) continue;
      if (type === '值班' && s === 'pm' && hasOutpatient) continue;
      if (type === '夜休' && (hasOutpatient || (s === 'am' && (hasGaoxin || hasZitong)))) continue;
      if (type === '中班' && cancelPreHolidayZhongban && isHoliday(workdayConfig, dayIdx + 1)) continue;

      const isOccupied = existDuty || hasOutpatient || (s === 'am' && (hasGaoxin || hasZitong));
      if (isOccupied) {
        const alreadyFlagged = newFlags.some(f => f.doctorId === docId && f.dayIdx === dayIdx && f.slot === s);
        if (!alreadyFlagged) {
          let conflictType = '';
          if (existDuty) conflictType = existDuty;
          else if (hasOutpatient) conflictType = '总院门诊';
          else if (s === 'am' && hasGaoxin) conflictType = '高新门诊';
          else if (s === 'am' && hasZitong) conflictType = '梓潼门诊';
          const doc = getDoctor(doctors, docId);
          newFlags.push({
            doctorId: docId, dayIdx, slot: s,
            reason: `${doc ? doc.name : docId} — ${type}与${conflictType}冲突，请手动处理`,
            isConflict: true
          });
        }
      } else {
        newDuty[docId][dayIdx][s] = type;
      }
    }
    return { dutyAssigned: newDuty, baiban1Flags: newFlags };
  }

  function computeHolidayRules(dutyAssigned, workdayConfig) {
    const result = cloneDutyAssigned(dutyAssigned || {});
    for (let docId in result) {
      for (let d = 0; d < 7; d++) {
        if (isHoliday(workdayConfig, d) && result[docId][d]) {
          for (let s of SLOTS) {
            if (HOLIDAY_FORBIDDEN.includes(result[docId][d][s])) result[docId][d][s] = '休';
          }
        }
      }
    }
    return result;
  }

  function computeConflicts(state) {
    const { doctors, outpatientGeneral, outpatientSimple, outpatientGaoxin, outpatientZitong, dutyAssigned } = state;
    let newFlags = (state.baiban1Flags || []).filter(f => f.isConflict);
    function hasExistingFlag(docId, dayIdx, slot) {
      return newFlags.some(f => f.doctorId === docId && f.dayIdx === dayIdx && f.slot === slot);
    }
    for (let docId in (dutyAssigned || {})) {
      const doc = getDoctor(doctors, docId);
      if (!doc) continue;
      for (let d = 0; d < 7; d++) {
        const dutySlots = (dutyAssigned[docId] || {})[d] || { am: null, pm: null };
        const genDay = (outpatientGeneral || {})[d] || { am: null, pm: null };
        const hasGaoxinAM = (outpatientGaoxin || []).some(a => a.dayIdx === d && a.doctorId === docId);
        const hasZitongAM = (outpatientZitong || []).some(a => a.dayIdx === d && a.doctorId === docId);
        const hasSimpleAM = (outpatientSimple || []).some(a => a.dayIdx === d && a.doctorId === docId && a.slot === 'am');
        const hasSimplePM = (outpatientSimple || []).some(a => a.dayIdx === d && a.doctorId === docId && a.slot === 'pm');
        const hasGeneralAM = genDay.am === docId || hasSimpleAM;
        const hasGeneralPM = genDay.pm === docId || hasSimplePM;

        if ((hasGaoxinAM || hasZitongAM) && dutySlots.pm === '值班' && !hasExistingFlag(doc.id, d, 'am')) {
          const clinicName = hasGaoxinAM ? '高新门诊' : '梓潼门诊';
          newFlags.push({ doctorId: doc.id, dayIdx: d, slot: 'am', reason: `${doc.name} — 上午${clinicName}+下午值班，请手动处理`, isConflict: true });
        }
        if ((hasGaoxinAM || hasZitongAM) && dutySlots.pm === '中班' && !hasExistingFlag(doc.id, d, 'pm')) {
          const clinicName = hasGaoxinAM ? '高新门诊' : '梓潼门诊';
          newFlags.push({ doctorId: doc.id, dayIdx: d, slot: 'pm', reason: `${doc.name} — 上午${clinicName}+下午中班，请手动处理`, isConflict: true });
        }
        if (hasGeneralAM && dutySlots.pm === '值班' && !hasExistingFlag(doc.id, d, 'am'))
          newFlags.push({ doctorId: doc.id, dayIdx: d, slot: 'am', reason: `${doc.name} — 上午总院门诊+下午值班，请手动处理`, isConflict: true });
        if (hasGeneralPM && dutySlots.pm === '中班' && !hasExistingFlag(doc.id, d, 'pm'))
          newFlags.push({ doctorId: doc.id, dayIdx: d, slot: 'pm', reason: `${doc.name} — 下午总院门诊+中班冲突，请手动处理`, isConflict: true });
      }
    }
    return newFlags;
  }

  function computeTraineeSync(state) {
    const { doctors, special } = state;
    let newDuty = cloneDutyAssigned(state.dutyAssigned || {});
    let newTraineeFlags = {};
    const trainees = doctors.filter(d => d.type === 'trainee');
    for (let t of trainees) {
      const mentor = getDoctor(doctors, t.mentorId);
      if (!mentor) continue;
      const mSched = getDoctorWeekSchedule(state, mentor.id);
      const tSpec = (special || {})[t.id] || {};
      ensureDutySlot(newDuty, t.id, 0);
      for (let d = 0; d < 7; d++) {
        ensureDutySlot(newDuty, t.id, d);
        for (let s of SLOTS) {
          if ((tSpec[d] || {})[s] || newDuty[t.id][d][s]) continue;
          const mSlot = mSched[d][s];
          if (t.training) continue;
          if (mSlot && (CLINIC_TYPES.includes(mSlot) || mSlot === '白班1')) continue;
          if (mSlot) newDuty[t.id][d][s] = mSlot;
        }
      }
    }
    return { dutyAssigned: newDuty, traineeFlags: newTraineeFlags };
  }

  function computeFillEmpty(state) {
    const { doctors, workdayConfig, special } = state;
    let newDuty = cloneDutyAssigned(state.dutyAssigned || {});
    let count = 0;
    for (let doc of doctors) {
      if (doc.type === 'trainee') continue;
      ensureDutySlot(newDuty, doc.id, 0);
      for (let d = 0; d < 7; d++) {
        ensureDutySlot(newDuty, doc.id, d);
        const fillType = (workdayConfig || [])[d] ? '白班普' : '休';
        for (let s of SLOTS) {
          if (!getSlotSchedule(state, doc.id, d, s)) {
            const ex = ((special || {})[doc.id] || {})[d];
            if (!ex || !ex[s]) { newDuty[doc.id][d][s] = fillType; count++; }
          }
        }
      }
    }
    return { dutyAssigned: newDuty, count };
  }

  function getWeekendDutyDoctors(state) {
    const result = [];
    for (let doc of state.doctors) {
      if (doc.type === 'trainee') continue;
      const sched = getDoctorWeekSchedule(state, doc.id);
      let hasHolidayDuty = false;
      for (let d = 0; d < 7; d++) {
        if (isHoliday(state.workdayConfig, d) && (sched[d].am === '值班' || sched[d].pm === '值班')) {
          hasHolidayDuty = true; break;
        }
      }
      if (hasHolidayDuty && !result.find(w => w.id === doc.id)) result.push({ id: doc.id, name: doc.name });
    }
    return result;
  }

  function computeWeekStats(state) {
    const counts = {};
    for (let doc of state.doctors) {
      const sched = getDoctorWeekSchedule(state, doc.id);
      for (let d = 0; d < 7; d++) {
        for (let s of SLOTS) {
          const v = sched[d][s];
          if (v) counts[v] = (counts[v] || 0) + 1;
        }
      }
    }
    return counts;
  }

  function resolveConflict(flags, dayIdx, slot, resolvedByDoctorId, resolvedByName) {
    return flags.map(f => {
      if (f.dayIdx === dayIdx && f.slot === slot) {
        return { ...f, reason: f.reason.replace('请手动处理', `已为${resolvedByName}安排白班1`), resolvedBy: resolvedByDoctorId };
      }
      return f;
    });
  }

  return {
    SCHEDULE_TYPES, TYPE_COLORS, SPECIAL_TYPES, CLINIC_TYPES, DUTY_TYPES, HOLIDAY_FORBIDDEN,
    DAYS, SLOTS, SLOT_LABELS,
    isWeekend, isHoliday, getDoctor, getSlotSchedule, getDoctorWeekSchedule,
    getDutyDoctorPool, getDutyEligibleDoctors, getBaiban1Candidates,
    getDutyRowDesc, getWeekendDutyDoctors,
    buildDefaultDutyOrder, computeAutoDuty, computeFillDayDuty,
    computeHolidayRules, computeConflicts, computeTraineeSync,
    computeFillEmpty, computeWeekStats, resolveConflict
  };
})();
