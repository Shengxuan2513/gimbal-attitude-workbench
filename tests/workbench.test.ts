import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateMappingCompleteness,
  guessDefaultMapping,
  parseAndValidateCsv,
} from '../src/data/csvParser.ts';
import { applyDisturbance } from '../src/data/disturbance.ts';
import { huberAngleKfFilter, standardAngleKfFilter, DEFAULT_KF_PARAMS } from '../src/filters/angleKf.ts';
import {
  buildTriAxisDiagnosticsCsv,
  formatAxisKfDiagnosticSummary,
} from '../src/filters/diagnosticsExport.ts';
import { fullImuAttitudeEkfPlaceholder } from '../src/filters/imuEkfInterface.ts';
import { buildActiveRotationMatrix, periodicAngleDiff } from '../src/math/angles.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEW_CSV_PATH = path.resolve(
  __dirname,
  '../samples/gimbal_20261118_222038_position_derived.csv'
);

test('CSV: rpm-only headers must return unmapped angle columns and reject import', () => {
  const headers = ['elapsed_s', 'yaw_rpm', 'roll_rpm', 'pitch_rpm'];
  const guessed = guessDefaultMapping(headers);
  assert.equal(guessed.timeCol, 'elapsed_s');
  assert.equal(guessed.rollCol, '');
  assert.equal(guessed.pitchCol, '');
  assert.equal(guessed.yawCol, '');

  const csv = 'elapsed_s,yaw_rpm,roll_rpm,pitch_rpm\n0,10,20,30\n0.5,11,21,31\n';
  const res = parseAndValidateCsv(csv, 'rpm_only.csv', {
    timeCol: guessed.timeCol ?? '',
    rollCol: guessed.rollCol ?? '',
    pitchCol: guessed.pitchCol ?? '',
    yawCol: guessed.yawCol ?? '',
    timeUnit: 's',
    angleUnit: 'deg',
    rotationOrder: 'ZYX',
    axisSigns: { roll: 1, pitch: 1, yaw: 1 },
  });
  assert.equal(res.ok, false);
});

test('CSV: mixed position and velocity columns pick position angles, not rpm', () => {
  const headers = ['time_ms', 'roll_rpm', 'roll_deg', 'pitch_rpm', 'pitch_deg', 'yaw_deg'];
  const guessed = guessDefaultMapping(headers);
  assert.equal(guessed.timeCol, 'time_ms');
  assert.equal(guessed.timeUnit, 'ms');
  assert.equal(guessed.rollCol, 'roll_deg');
  assert.equal(guessed.pitchCol, 'pitch_deg');
  assert.equal(guessed.yawCol, 'yaw_deg');
});

test('CSV: rejects -1e308 to 1e308 overflow and preserves micro-differences 0, 0.0000004, 0.0000008', () => {
  const overflowCsv = 'time_s,roll_deg,pitch_deg,yaw_deg\n-1e308,0,0,0\n1e308,1,1,1\n';
  const overflowRes = parseAndValidateCsv(overflowCsv, 'overflow.csv', {
    timeCol: 'time_s',
    rollCol: 'roll_deg',
    pitchCol: 'pitch_deg',
    yawCol: 'yaw_deg',
    timeUnit: 's',
    angleUnit: 'deg',
    rotationOrder: 'ZYX',
    axisSigns: { roll: 1, pitch: 1, yaw: 1 },
  });
  assert.equal(overflowRes.ok, false);
  if (!overflowRes.ok) {
    assert.match(overflowRes.errors[0], /第 3 行/);
  }

  const microCsv =
    'time_s,roll_deg,pitch_deg,yaw_deg\n0,0,0,0\n0.0000004,1,2,3\n0.0000008,2,4,6\n';
  const microRes = parseAndValidateCsv(microCsv, 'micro.csv', {
    timeCol: 'time_s',
    rollCol: 'roll_deg',
    pitchCol: 'pitch_deg',
    yawCol: 'yaw_deg',
    timeUnit: 's',
    angleUnit: 'deg',
    rotationOrder: 'ZYX',
    axisSigns: { roll: 1, pitch: 1, yaw: 1 },
  });
  assert.equal(microRes.ok, true);
  if (microRes.ok) {
    assert.deepEqual(microRes.dataset.times, [0, 0.0000004, 0.0000008]);
    assert.ok(microRes.dataset.rawSource && microRes.dataset.rawSource.rows.length === 3);
    assert.ok(microRes.dataset.importConfig);
  }
});

test('Axis sign conversion happens once at import and rotation matrix uses normalized angle', () => {
  const csv = 'time_s,roll_deg,pitch_deg,yaw_deg\n0,30,0,0\n0.5,30,0,0\n';
  const res = parseAndValidateCsv(csv, 'sign.csv', {
    timeCol: 'time_s',
    rollCol: 'roll_deg',
    pitchCol: 'pitch_deg',
    yawCol: 'yaw_deg',
    timeUnit: 's',
    angleUnit: 'deg',
    rotationOrder: 'ZYX',
    axisSigns: { roll: -1, pitch: 1, yaw: 1 },
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.dataset.roll[0], -30);
    const mat = buildActiveRotationMatrix(res.dataset.roll[0], 0, 0, 'ZYX');
    // For Rx(-30°), element (1,2) = -sin(-30°) = +0.5
    const e = mat.elements; // column-major
    assert.ok(Math.abs(e[9] - 0.5) < 1e-6); // row 1, col 2 in column-major is index 9? Wait: row 1 col 2 is 2*4+1 = 9!
  }
});

test('New dataset: 8s Pitch +20° spike hits frame 17 (t=8.093s), Huber downweights without square', () => {
  const rawCsv = fs.readFileSync(NEW_CSV_PATH, 'utf8');
  const parsed = parseAndValidateCsv(rawCsv, 'gimbal_20261118_222038_position_derived.csv', {
    timeCol: 'time_s',
    rollCol: 'roll_deg',
    pitchCol: 'pitch_deg',
    yawCol: 'yaw_deg',
    timeUnit: 's',
    angleUnit: 'deg',
    rotationOrder: 'ZYX',
    axisSigns: { roll: 1, pitch: 1, yaw: 1 },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const ds = parsed.dataset;
  assert.equal(ds.times.length, 50);

  const distRes = applyDisturbance(ds, {
    enabled: true,
    type: 'spike',
    axis: 'pitch',
    startTime: 8.0,
    amplitude: 20,
    duration: 2.0,
  });
  assert.ok(distRes.applied);
  assert.deepEqual(distRes.applied.hitIndices, [16]); // 17th frame (1-based)
  assert.equal(ds.times[16], 8.093);
  assert.equal(ds.pitch[16], -12.281153);
  assert.ok(Math.abs(distRes.disturbed.pitch[16] - 7.718847) < 1e-6);

  // Repeated apply produces identical output (no accumulation)
  const distRes2 = applyDisturbance(ds, {
    enabled: true,
    type: 'spike',
    axis: 'pitch',
    startTime: 8.0,
    amplitude: 20,
    duration: 2.0,
  });
  assert.equal(distRes2.disturbed.pitch[16], distRes.disturbed.pitch[16]);

  const input = {
    times: ds.times,
    roll: distRes.disturbed.roll,
    pitch: distRes.disturbed.pitch,
    yaw: distRes.disturbed.yaw,
  };
  const stdOut = standardAngleKfFilter.run(input);
  const huberOut = huberAngleKfFilter.run(input, { mu: 2.0 });

  const d16 = huberOut.diagnostics!.pitch[16];
  assert.ok(Math.abs(d16.normalizedResidual) > 2.0);
  const expectedW = 2.0 / Math.abs(d16.normalizedResidual);
  assert.ok(Math.abs(d16.weight - expectedW) < 1e-9);
  assert.ok(d16.rEff > DEFAULT_KF_PARAMS.r);
  assert.ok(d16.covSymmetric && d16.covPsd);
  assert.notEqual(huberOut.pitch[16], stdOut.pitch[16]);
});

test('Angle KF: w=1 matches standard KF, handles ±180° wrap & unequal dt & PSD covariance', () => {
  const times = [0, 0.02, 0.15, 0.65, 1.25, 1.27];
  const roll = [178, 179, -179.5, -178, -176.5, -175];
  const pitch = [0, 1, 2, 3, 4, 5];
  const yaw = [10, 10, 10, 10, 10, 10];

  // With huge mu, w=1 everywhere -> Huber KF === Standard KF
  const stdOut = standardAngleKfFilter.run({ times, roll, pitch, yaw });
  const huberHighMu = huberAngleKfFilter.run({ times, roll, pitch, yaw }, { mu: 1e6 });

  for (let i = 0; i < times.length; i++) {
    assert.ok(Math.abs(periodicAngleDiff(stdOut.roll[i], huberHighMu.roll[i])) < 1e-10);
    assert.ok(Math.abs(periodicAngleDiff(stdOut.pitch[i], huberHighMu.pitch[i])) < 1e-10);
    assert.equal(huberHighMu.diagnostics!.roll[i].weight, 1);
    assert.ok(huberHighMu.diagnostics!.roll[i].covSymmetric);
    assert.ok(huberHighMu.diagnostics!.roll[i].covPsd);
    assert.ok(Math.abs(huberHighMu.diagnostics!.roll[i].innovation) < 10); // no 358° jump
  }
});

test('Full IMU EKF interface reports unavailable without body-frame gyro/accel', () => {
  const status = fullImuAttitudeEkfPlaceholder.checkAvailability({ times: [0, 0.5, 1.0] });
  assert.equal(status.available, false);
});

test('CSV mapping completeness: unmapped disables confirm, completing mapping enables, file/mapping change refreshes', () => {
  // 1. rpm-only file -> unmapped angle cols -> incomplete
  const rpmHeaders = ['elapsed_s', 'yaw_rpm', 'roll_rpm', 'pitch_rpm'];
  const rpmGuess = guessDefaultMapping(rpmHeaders);
  const statusIncomplete = evaluateMappingCompleteness(true, {
    timeCol: rpmGuess.timeCol ?? '',
    rollCol: rpmGuess.rollCol ?? '',
    pitchCol: rpmGuess.pitchCol ?? '',
    yawCol: rpmGuess.yawCol ?? '',
  });
  assert.equal(statusIncomplete.complete, false);
  assert.deepEqual(statusIncomplete.missingLabels, ['Roll 列', 'Pitch 列', 'Yaw 列']);

  // 2. Completing mapping manually -> enabled
  const statusComplete = evaluateMappingCompleteness(true, {
    timeCol: 'elapsed_s',
    rollCol: 'custom_r',
    pitchCol: 'custom_p',
    yawCol: 'custom_y',
  });
  assert.equal(statusComplete.complete, true);
  assert.equal(statusComplete.missingLabels.length, 0);

  // 3. Clearing one mapping -> disabled again
  const statusCleared = evaluateMappingCompleteness(true, {
    timeCol: 'elapsed_s',
    rollCol: '',
    pitchCol: 'custom_p',
    yawCol: 'custom_y',
  });
  assert.equal(statusCleared.complete, false);
  assert.deepEqual(statusCleared.missingLabels, ['Roll 列']);
});

test('Tri-axis KF diagnostics: R/P/Y have independent actual values, export has 3*N rows, smooth mode blocks export', () => {
  const rawCsv = fs.readFileSync(NEW_CSV_PATH, 'utf8');
  const parsed = parseAndValidateCsv(rawCsv, 'gimbal_20261118_222038_position_derived.csv', {
    timeCol: 'time_s',
    rollCol: 'roll_deg',
    pitchCol: 'pitch_deg',
    yawCol: 'yaw_deg',
    timeUnit: 's',
    angleUnit: 'deg',
    rotationOrder: 'ZYX',
    axisSigns: { roll: 1, pitch: 1, yaw: 1 },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const ds = parsed.dataset;
  const distConfig = {
    enabled: true,
    type: 'spike' as const,
    axis: 'pitch' as const,
    startTime: 8.0,
    amplitude: 20,
    duration: 2.0,
  };
  const distRes = applyDisturbance(ds, distConfig);
  const robOut = huberAngleKfFilter.run(
    {
      times: ds.times,
      roll: distRes.disturbed.roll,
      pitch: distRes.disturbed.pitch,
      yaw: distRes.disturbed.yaw,
    },
    { mu: 2.0 }
  );

  // Roll, Pitch, Yaw diagnostics at frame 17 (idx 16) are genuinely distinct
  const dr16 = robOut.diagnostics!.roll[16];
  const dp16 = robOut.diagnostics!.pitch[16];
  const dy16 = robOut.diagnostics!.yaw[16];
  assert.notEqual(dp16.weight, dr16.weight);
  assert.notEqual(dy16.predicted, dp16.predicted);

  const summaryYaw = formatAxisKfDiagnosticSummary(
    16,
    ds.times[16],
    'yaw',
    distRes.disturbed.yaw[16],
    robOut.yaw[16],
    dy16,
    true
  );
  assert.match(summaryYaw, /Yaw/);
  assert.match(summaryYaw, /t=8\.093s/);

  // Export tri-axis CSV in KF mode
  const csvOut = buildTriAxisDiagnosticsCsv({
    dataset: ds,
    filterMode: 'kf',
    filterName: huberAngleKfFilter.name,
    paramsSummary: robOut.paramsSummary ?? '',
    disturbanceConfig: distConfig,
    appliedDisturbance: distRes.applied,
    disturbedSeries: distRes.disturbed,
    robustSeries: robOut,
  });
  assert.ok(csvOut !== null);
  const lines = csvOut!.split('\n');
  const metaLines = lines.filter((l) => l.startsWith('#'));
  const dataLines = lines.filter((l) => !l.startsWith('#') && !l.startsWith('frame_idx,'));
  assert.ok(metaLines.length >= 5);
  assert.equal(dataLines.length, ds.times.length * 3); // 50 * 3 = 150 rows

  // Verify frame 17 (idx 16) Pitch row in exported CSV
  const pitchRow17 = dataLines.find((l) => l.startsWith('17,8.093,pitch,'));
  assert.ok(pitchRow17);
  assert.ok(pitchRow17!.includes(dp16.weight.toFixed(6)));

  // Smooth fallback mode must NOT export residual KF diagnostics
  const smoothExport = buildTriAxisDiagnosticsCsv({
    dataset: ds,
    filterMode: 'smooth',
    filterName: 'smooth',
    paramsSummary: '',
    disturbanceConfig: distConfig,
    appliedDisturbance: distRes.applied,
    disturbedSeries: distRes.disturbed,
    robustSeries: robOut,
  });
  assert.equal(smoothExport, null);
});
