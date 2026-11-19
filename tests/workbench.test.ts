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
import {
  buildNormalizedSixAxisCsv,
  buildSixAxisQualityReport,
  createSimulatedSixAxisDataset,
  evaluateSixAxisCompleteness,
  guessSixAxisMapping,
  parseAndValidateSixAxisCsv,
  parseHmsTimestampSec,
  SIX_AXIS_TEMPLATE_CSV,
  STANDARD_GRAVITY_M_S2,
} from '../src/data/sixAxisParser.ts';
import { inspectWitMotionBin } from '../src/data/witMotionBin.ts';
import { huberAngleKfFilter, standardAngleKfFilter, DEFAULT_KF_PARAMS } from '../src/filters/angleKf.ts';
import {
  buildTriAxisDiagnosticsCsv,
  formatAxisKfDiagnosticSummary,
} from '../src/filters/diagnosticsExport.ts';
import { fullImuAttitudeEkfPlaceholder } from '../src/filters/imuEkfInterface.ts';
import {
  buildSixAxisEskfComparisonCsv,
  DEFAULT_SIX_AXIS_ESKF_PARAMS,
  rightJacobianSO3,
  runHuberSixAxisEskf,
  runStandardSixAxisEskf,
} from '../src/filters/sixAxisEskf.ts';
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

test('Six-axis mapping: never mis-maps rpm/deg_s2/position, requires explicit units and physical-meaning confirmation', () => {
  const excelHeaders = [
    'elapsed_s',
    'yaw_rpm',
    'roll_rpm',
    'pitch_rpm',
    'ax_deg_s2',
    'roll_deg',
  ];
  const badGuess = guessSixAxisMapping(excelHeaders);
  assert.equal(badGuess.gxCol, '');
  assert.equal(badGuess.axCol, '');

  const imuHeaders = ['time_ms', 'gx_deg_s', 'gy_deg_s', 'gz_deg_s', 'ax_g', 'ay_g', 'az_g'];
  const goodGuess = guessSixAxisMapping(imuHeaders);
  assert.equal(goodGuess.timeCol, 'time_ms');
  assert.equal(goodGuess.timeUnit, 'ms');
  assert.equal(goodGuess.gyroUnit, 'deg_s');
  assert.equal(goodGuess.accelUnit, 'g');

  const incomplete = evaluateSixAxisCompleteness(true, {
    timeCol: 'time_ms',
    gxCol: 'gx_deg_s',
    gyCol: 'gy_deg_s',
    gzCol: 'gz_deg_s',
    axCol: 'ax_g',
    ayCol: 'ay_g',
    azCol: 'az_g',
    timeUnit: 'ms',
    gyroUnit: 'deg_s',
    accelUnit: '',
    confirmedPhysicalMeaning: false,
  });
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.missingItems.includes('比力单位'));
  assert.ok(incomplete.missingItems.includes('物理含义确认勾选'));
});

test('Six-axis parser: converts ms/deg_s/g accurately, rejects non-finite/overflow/out-of-order, preserves simulated flag', () => {
  const csv = [
    'time_ms,gx_deg_s,gy_deg_s,gz_deg_s,ax_g,ay_g,az_g',
    '1000,180,0,0,0,0,1',
    '1020,180,90,0,0,0,1',
  ].join('\n');

  const res = parseAndValidateSixAxisCsv(csv, 'imu_test.csv', {
    timeCol: 'time_ms',
    gxCol: 'gx_deg_s',
    gyCol: 'gy_deg_s',
    gzCol: 'gz_deg_s',
    axCol: 'ax_g',
    ayCol: 'ay_g',
    azCol: 'az_g',
    timeUnit: 'ms',
    gyroUnit: 'deg_s',
    accelUnit: 'g',
    gyroSigns: { x: -1, y: 1, z: 1 },
    accelSigns: { x: 1, y: 1, z: 1 },
    timeBase: 'device_sample',
    confirmedPhysicalMeaning: true,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.dataset.times[0], 0);
    assert.ok(Math.abs(res.dataset.times[1] - 0.02) < 1e-12);
    assert.ok(Math.abs(res.dataset.gx[0] - -Math.PI) < 1e-6);
    assert.ok(Math.abs(res.dataset.gy[1] - Math.PI / 2) < 1e-6);
    assert.ok(Math.abs(res.dataset.az[0] - STANDARD_GRAVITY_M_S2) < 1e-6);
    assert.equal(res.dataset.isSimulatedSample, false);
  }

  // Overflow / non-finite check
  const badCsv = [
    'time_s,gx_rad_s,gy_rad_s,gz_rad_s,ax_m_s2,ay_m_s2,az_m_s2',
    '-1e308,0,0,0,0,0,9.81',
    '1e308,0,0,0,0,0,9.81',
  ].join('\n');
  const badRes = parseAndValidateSixAxisCsv(badCsv, 'bad.csv', {
    timeCol: 'time_s',
    gxCol: 'gx_rad_s',
    gyCol: 'gy_rad_s',
    gzCol: 'gz_rad_s',
    axCol: 'ax_m_s2',
    ayCol: 'ay_m_s2',
    azCol: 'az_m_s2',
    timeUnit: 's',
    gyroUnit: 'rad_s',
    accelUnit: 'm_s2',
    gyroSigns: { x: 1, y: 1, z: 1 },
    accelSigns: { x: 1, y: 1, z: 1 },
    timeBase: 'unknown',
    confirmedPhysicalMeaning: true,
  });
  assert.equal(badRes.ok, false);
  if (!badRes.ok) {
    assert.match(badRes.errors[0], /第 3 行/);
  }

  // Simulated sample & template
  const sim = createSimulatedSixAxisDataset();
  assert.equal(sim.isSimulatedSample, true);
  assert.equal(sim.times.length, 251);
  assert.ok(Math.abs(sim.programChecks.accelNormMean - STANDARD_GRAVITY_M_S2) < 0.05);

  const tplRes = parseAndValidateSixAxisCsv(
    SIX_AXIS_TEMPLATE_CSV,
    'six_axis_imu_template.csv',
    sim.importConfig,
    true
  );
  assert.equal(tplRes.ok, true);
});

test('WitMotion Chinese headers: maps on-chip time, accel(g), gyro(deg/s), preserves duplicate host time & invalid date 2000-00-00', () => {
  const headers = [
    '时间',
    '设备名称',
    '片上时间()',
    '加速度X(g)',
    '加速度Y(g)',
    '加速度Z(g)',
    '角速度X(°/s)',
    '角速度Y(°/s)',
    '角速度Z(°/s)',
    '角度X(°)',
    '磁场X(ʯt)',
  ];
  const g = guessSixAxisMapping(headers);
  assert.equal(g.timeCol, '片上时间()');
  assert.equal(g.hostTimeCol, '时间');
  assert.equal(g.timeUnit, 'hms');
  assert.equal(g.gyroUnit, 'deg_s');
  assert.equal(g.accelUnit, 'g');
  assert.equal(g.axCol, '加速度X(g)');
  assert.equal(g.gxCol, '角速度X(°/s)');

  assert.equal(parseHmsTimestampSec('2000-00-00 00:36:31.640')?.toFixed(3), '2191.640');

  const csv = [
    headers.join(','),
    ' 20:53:14.620,COM9, 2000-00-00 00:36:31.650, -0.9395, 0.1196, 0.3281, 0.3052, 0.0610, -0.0610, 20.468, 0.000',
    ' 20:53:14.620,COM9, 2000-00-00 00:36:31.660, -0.9395, 0.1216, 0.3291, 0.6104, 0.0610, 0.1831, 20.468, 0.000',
    ' 20:53:14.620,COM9, 2000-00-00 00:36:31.670, -0.9380, 0.1200, 0.3300, 0.0000, 0.1221, 0.0000, 20.468, 0.000',
  ].join('\n');

  const res = parseAndValidateSixAxisCsv(csv, 'wt_test.csv', {
    timeCol: g.timeCol!,
    hostTimeCol: g.hostTimeCol,
    gxCol: g.gxCol!,
    gyCol: g.gyCol!,
    gzCol: g.gzCol!,
    axCol: g.axCol!,
    ayCol: g.ayCol!,
    azCol: g.azCol!,
    timeUnit: 'hms',
    gyroUnit: 'deg_s',
    accelUnit: 'g',
    gyroSigns: { x: 1, y: 1, z: 1 },
    accelSigns: { x: 1, y: 1, z: 1 },
    timeBase: 'onchip_hms',
    confirmedPhysicalMeaning: true,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    // Must NOT deduplicate by repeated computer time 20:53:14.620
    assert.equal(res.dataset.times.length, 3);
    assert.equal(res.dataset.programChecks.duplicateHostTimeCount, 2);
    assert.equal(res.dataset.programChecks.binVerified, false);
    assert.ok(Math.abs(res.dataset.programChecks.effectiveHz - 100) < 1e-6);

    const normCsv = buildNormalizedSixAxisCsv(res.dataset);
    assert.equal(normCsv.split('\n').length, 4); // header + 3 rows
    const report = JSON.parse(buildSixAxisQualityReport(res.dataset));
    assert.equal(report.counts.duplicateHostTimeCount, 2);
    assert.equal(report.binInspection, null);
  }
});

test('Six-axis HMS time: handles normal midnight rollover, rejects device reboot and time regression', () => {
  const baseCfg = {
    timeCol: 't',
    gxCol: 'gx',
    gyCol: 'gy',
    gzCol: 'gz',
    axCol: 'ax',
    ayCol: 'ay',
    azCol: 'az',
    timeUnit: 'hms' as const,
    gyroUnit: 'rad_s' as const,
    accelUnit: 'm_s2' as const,
    gyroSigns: { x: 1 as const, y: 1 as const, z: 1 as const },
    accelSigns: { x: 1 as const, y: 1 as const, z: 1 as const },
    timeBase: 'onchip_hms' as const,
    confirmedPhysicalMeaning: true,
  };

  // Normal midnight rollover: 23:59:59.990 -> 00:00:00.010
  const rolloverCsv = [
    't,gx,gy,gz,ax,ay,az',
    '2000-00-00 23:59:59.990,0,0,0,0,0,9.81',
    '2000-00-00 00:00:00.010,0,0,0,0,0,9.81',
  ].join('\n');
  const rollRes = parseAndValidateSixAxisCsv(rolloverCsv, 'rollover.csv', baseCfg);
  assert.equal(rollRes.ok, true);
  if (rollRes.ok) {
    assert.equal(rollRes.dataset.programChecks.midnightRolloverCount, 1);
    assert.ok(Math.abs(rollRes.dataset.times[1] - 0.02) < 1e-9);
  }

  // Device reboot: 00:36:40.000 -> 00:00:00.010 (must NOT treat as midnight rollover)
  const rebootCsv = [
    't,gx,gy,gz,ax,ay,az',
    '2000-00-00 00:36:40.000,0,0,0,0,0,9.81',
    '2000-00-00 00:00:00.010,0,0,0,0,0,9.81',
  ].join('\n');
  const rebootRes = parseAndValidateSixAxisCsv(rebootCsv, 'reboot.csv', baseCfg);
  assert.equal(rebootRes.ok, false);
  if (!rebootRes.ok) {
    assert.match(rebootRes.errors[0], /第 3 行.*重启/);
  }

  // Regression: 00:36:40.000 -> 00:36:39.500
  const regCsv = [
    't,gx,gy,gz,ax,ay,az',
    '2000-00-00 00:36:40.000,0,0,0,0,0,9.81',
    '2000-00-00 00:36:39.500,0,0,0,0,0,9.81',
  ].join('\n');
  const regRes = parseAndValidateSixAxisCsv(regCsv, 'reg.csv', baseCfg);
  assert.equal(regRes.ok, false);
  if (!regRes.ok) {
    assert.match(regRes.errors[0], /第 3 行.*逆序/);
  }
});

test('WitMotion .bin inspector: detects truncated tail packet, checksum errors, missing packet, and excludes incomplete group', () => {
  function makePkt(type: number): number[] {
    const p = [0x55, type, 1, 2, 3, 4, 5, 6, 7, 8, 0];
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += p[i];
    p[10] = sum & 0xff;
    return p;
  }

  // 3 time, 3 accel, 2 gyro + 1 truncated 10-byte gyro at EOF
  const bytes = new Uint8Array([
    ...makePkt(0x50),
    ...makePkt(0x51),
    ...makePkt(0x52),
    ...makePkt(0x50),
    ...makePkt(0x51),
    ...makePkt(0x52),
    ...makePkt(0x50),
    ...makePkt(0x51),
    0x55,
    0x52,
    0x06,
    0x00,
    0x02,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
  const info = inspectWitMotionBin(bytes, 'test.bin');
  assert.equal(info.timePacketCount, 3);
  assert.equal(info.accelPacketCount, 3);
  assert.equal(info.gyroPacketCount, 2);
  assert.equal(info.completeGroupCount, 2);
  assert.equal(info.badChecksumCount, 0);
  assert.equal(info.truncatedTailBytes, 10);
  assert.match(info.truncatedTailPacketType ?? '', /0x52/);

  // Bad checksum packet
  const badPkt = makePkt(0x51);
  badPkt[10] ^= 0xff;
  const badInfo = inspectWitMotionBin(new Uint8Array(badPkt), 'bad.bin');
  assert.equal(badInfo.badChecksumCount, 1);
  assert.equal(badInfo.completeGroupCount, 0);

  // Integrating with 3-row CSV excludes trailing 1 incomplete group
  const csv3 = [
    't,gx,gy,gz,ax,ay,az',
    '0.00,0,0,0,0,0,9.81',
    '0.01,0,0,0,0,0,9.81',
    '0.02,0,0,0,0,0,9.81',
  ].join('\n');
  const parsed = parseAndValidateSixAxisCsv(
    csv3,
    'test.csv',
    {
      timeCol: 't',
      gxCol: 'gx',
      gyCol: 'gy',
      gzCol: 'gz',
      axCol: 'ax',
      ayCol: 'ay',
      azCol: 'az',
      timeUnit: 's',
      gyroUnit: 'rad_s',
      accelUnit: 'm_s2',
      gyroSigns: { x: 1, y: 1, z: 1 },
      accelSigns: { x: 1, y: 1, z: 1 },
      timeBase: 'device_sample',
      confirmedPhysicalMeaning: true,
    },
    false,
    info
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.dataset.programChecks.totalCsvRows, 3);
    assert.equal(parsed.dataset.programChecks.validCompleteGroups, 2);
    assert.equal(parsed.dataset.programChecks.excludedCount, 1);
    assert.equal(parsed.dataset.times.length, 2);
  }
});

test('Six-axis validation: rejects NaN/Infinity, duplicate time, missing col, duplicate col mapping, and unit overflow', () => {
  const baseCfg = {
    timeCol: 't',
    gxCol: 'gx',
    gyCol: 'gy',
    gzCol: 'gz',
    axCol: 'ax',
    ayCol: 'ay',
    azCol: 'az',
    timeUnit: 's' as const,
    gyroUnit: 'rad_s' as const,
    accelUnit: 'g' as const,
    gyroSigns: { x: 1 as const, y: 1 as const, z: 1 as const },
    accelSigns: { x: 1 as const, y: 1 as const, z: 1 as const },
    timeBase: 'device_sample' as const,
    confirmedPhysicalMeaning: true,
  };

  // NaN / Infinity
  const nanCsv = 't,gx,gy,gz,ax,ay,az\n0,0,0,0,0,0,1\n0.01,NaN,0,0,0,0,Infinity\n';
  const nanRes = parseAndValidateSixAxisCsv(nanCsv, 'nan.csv', baseCfg);
  assert.equal(nanRes.ok, false);
  if (!nanRes.ok) assert.match(nanRes.errors[0], /第 3 行/);

  // Duplicate time
  const dupTimeCsv = 't,gx,gy,gz,ax,ay,az\n0,0,0,0,0,0,1\n0,0,0,0,0,0,1\n';
  const dupRes = parseAndValidateSixAxisCsv(dupTimeCsv, 'dup.csv', baseCfg);
  assert.equal(dupRes.ok, false);
  if (!dupRes.ok) assert.match(dupRes.errors[0], /第 3 行.*重复/);

  // Missing mapped column in header
  const missRes = parseAndValidateSixAxisCsv('t,gx,gy\n0,0,0\n0.01,0,0\n', 'miss.csv', baseCfg);
  assert.equal(missRes.ok, false);

  // Duplicate column mapping
  const dupMap = evaluateSixAxisCompleteness(true, { ...baseCfg, gyCol: 'gx' });
  assert.equal(dupMap.complete, false);

  // Unit-conversion overflow (1e308 * 9.80665 -> Infinity)
  const ovfCsv = 't,gx,gy,gz,ax,ay,az\n0,0,0,0,0,0,1\n0.01,0,0,0,0,0,1e308\n';
  const ovfRes = parseAndValidateSixAxisCsv(ovfCsv, 'ovf.csv', baseCfg);
  assert.equal(ovfRes.ok, false);
  if (!ovfRes.ok) assert.match(ovfRes.errors[0], /第 3 行.*非有限/);
});

test('Six-axis ESKF: A0 and A4 match when mu is large, and A4 downweights specific-force spike', () => {
  const jrZero = rightJacobianSO3([0, 0, 0]);
  assert.equal(jrZero[0][0], 1);
  assert.equal(jrZero[1][1], 1);

  const sim = createSimulatedSixAxisDataset();
  const dsStationary = {
    ...sim,
    gx: sim.gx.map(() => 0),
    gy: sim.gy.map(() => 0),
    gz: sim.gz.map(() => 0),
    ax: sim.ax.map(() => 0),
    ay: sim.ay.map(() => 0),
    az: sim.az.map(() => STANDARD_GRAVITY_M_S2),
  };
  // Clean stationary dataset with large mu -> A4 matches A0 to machine precision
  const a0Clean = runStandardSixAxisEskf(dsStationary, DEFAULT_SIX_AXIS_ESKF_PARAMS);
  const a4HighMu = runHuberSixAxisEskf(dsStationary, {
    ...DEFAULT_SIX_AXIS_ESKF_PARAMS,
    muX: 1e4,
    muY: 1e4,
  });
  for (let i = 0; i < dsStationary.times.length; i++) {
    assert.equal(a4HighMu.wyMean[i], 1);
    assert.equal(a4HighMu.wxMean[i], 1);
    assert.ok(Math.abs(a0Clean.rollDeg[i] - a4HighMu.rollDeg[i]) < 1e-8);
    assert.ok(Math.abs(a0Clean.pitchDeg[i] - a4HighMu.pitchDeg[i]) < 1e-8);
  }

  // Inject +30 m/s^2 specific-force spike on stationary dataset at frame 100
  const dsSpike = {
    ...dsStationary,
    ax: dsStationary.ax.map((v, i) => (i === 100 ? 30.0 : v)),
  };
  const a0Spk = runStandardSixAxisEskf(dsSpike);
  const a4Spk = runHuberSixAxisEskf(dsSpike);
  assert.ok(a4Spk.wyMean[100] < 0.75);
  assert.ok(Math.abs(a4Spk.pitchDeg[100]) < Math.abs(a0Spk.pitchDeg[100]));

  const csv = buildSixAxisEskfComparisonCsv(dsSpike, a0Spk, a4Spk);
  assert.equal(csv.split('\n').filter((l) => !l.startsWith('#')).length, dsSpike.times.length + 1);
});
