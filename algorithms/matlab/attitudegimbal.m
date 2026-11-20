%% 云台三轴正弦运动模型 + 四元数误差状态扩展卡尔曼滤波（ES-EKF）
% 适用数据：elapsed_s、三轴 rpm、三轴 deg/s^2、三轴角度 deg。
% 内部欧拉角顺序固定为 [roll; pitch; yaw]，旋转顺序为 Z-Y-X：
% R = Rz(yaw) * Ry(pitch) * Rx(roll)，四元数格式为 [w; x; y; z]。
%
% 使用方法：
% 1) 将本文件与 xlsx 放在同一目录，或把 dataFile 改为完整路径；
% 2) 根据实际运动设置修改 cfg.Omega、量测噪声和过程噪声；
% 3) 运行本脚本。结果图和"云台三轴姿态EKF估计结果.csv"会自动生成。
%
% 说明：直接归一化四元数的普通 EKF 会破坏单位范数约束的协方差表达。
% 本程序使用右乘姿态误差 q_true = q_nom (x) Exp(dtheta)，名义姿态始终
% 为单位四元数，滤波状态为 9 维小误差 [dtheta; dnu; dacc]，是 EKF 的
% 常用误差状态实现。nu、dacc 分别是欧拉角速度和欧拉角加速度。

clear; clc; close all;

dataFile = '云台三轴速度加速度位置记录_20261118_222038.xlsx';
outputFile = '云台三轴姿态EKF估计结果.csv';

%% 1. 参数配置
cfg.Omega = 0.4*pi;             % 正弦角频率 rad/s；本数据约为 0.4*pi
cfg.autoFitSine = true;          % true：由角度数据拟合幅值、相位、偏置
cfg.fitSkipFirstRow = true;      % 本文件首行全零，与后续正弦轨迹不一致

% 若 autoFitSine = false，使用以下人工设定；顺序均为 [roll; pitch; yaw]
cfg.manualAmplitudeDeg = [10; 10; 15];
cfg.manualOffsetDeg = [-5.5; -5.5; -8.25];
cfg.manualPhaseRad = [0; 0; 0];

% 量测噪声标准差：按传感器精度调整，而非把三列数据当成完全独立真值
cfg.angleStdDeg = [0.5; 0.5; 0.5];
cfg.rateStdRpm = [0.15; 0.15; 0.15];
cfg.accStdDegS2 = [3.0; 3.0; 3.0];

% 连续 jerk（角加加速度）过程噪声谱密度开方，单位 deg/s^3
% 数值越大，越信任量测；数值越小，越信任正弦动力学预测。
cfg.jerkSpectralDegS3 = [8; 8; 8];

% 初始误差标准差
cfg.initialAngleStdDeg = [3; 3; 3];
cfg.initialRateStdRpm = [1; 1; 1];
cfg.initialAccStdDegS2 = [10; 10; 10];

% 新息门限：前 gateWarmup 个采样点不拦截，以便从粗初值快速收敛
cfg.useInnovationGate = true;
cfg.nisGate = 16.919;            % 9 维联合新息：卡方分布 95% 分位点
cfg.gateWarmup = 4;

%% 2. 读取并统一单位
T = readtable(dataFile, 'VariableNamingRule', 'preserve');
requiredColumns = {'elapsed_s', ...
    'yaw_rpm', 'roll_rpm', 'pitch_rpm', ...
    'yaw_accel_deg_s2', 'roll_accel_deg_s2', 'pitch_accel_deg_s2', ...
    'yaw_position_deg', 'roll_position_deg', 'pitch_position_deg'};
assert(all(ismember(requiredColumns, T.Properties.VariableNames)), ...
    '输入表缺少必要列，请检查列名。');

t = T.elapsed_s(:);
N = numel(t);
assert(N >= 2 && all(isfinite(t)) && all(diff(t) > 0), ...
    '时间列必须有限且严格递增。');

% Nx3，列顺序统一为 roll、pitch、yaw
etaMeas = (pi/180) * [T.roll_position_deg, T.pitch_position_deg, T.yaw_position_deg];
nuMeas = (2*pi/60) * [T.roll_rpm, T.pitch_rpm, T.yaw_rpm];       % rad/s
accMeas = (pi/180) * [T.roll_accel_deg_s2, T.pitch_accel_deg_s2, T.yaw_accel_deg_s2];

validRows = all(isfinite([etaMeas, nuMeas, accMeas]), 2);
assert(all(validRows), '当前程序要求量测无 NaN；若有缺测，可在对应时刻只预测不更新。');

%% 3. 正弦名义模型 eta = C + A*sin(Omega*t + phi)
sine = configureSineModel(t, etaMeas, cfg);
axisNames = {'roll', 'pitch', 'yaw'};
fprintf('正弦模型（内部顺序 roll / pitch / yaw）：\n');
for j = 1:3
    fprintf('%-5s A = %9.5f deg, phase = %9.6f rad, C = %9.5f deg\n', ...
        axisNames{j}, sine.A(j)*180/pi, sine.phi(j), sine.C(j)*180/pi);
end

%% 4. 初始化名义状态、误差协方差和记录数组
% q：姿态四元数；nu：欧拉角速度；acc：欧拉角加速度
q = eul2quatZYX(etaMeas(1, :)');
nu = nuMeas(1, :)';
acc = accMeas(1, :)';

P = zeros(9, 9);
P(1:3, 1:3) = diag(((pi/180)*cfg.initialAngleStdDeg).^2);
P(4:6, 4:6) = diag(((2*pi/60)*cfg.initialRateStdRpm).^2);
P(7:9, 7:9) = diag(((pi/180)*cfg.initialAccStdDegS2).^2);

R = zeros(9, 9);
R(1:3, 1:3) = diag(((2*pi/60)*cfg.rateStdRpm).^2);
R(4:6, 4:6) = diag(((pi/180)*cfg.accStdDegS2).^2);
R(7:9, 7:9) = diag(((pi/180)*cfg.angleStdDeg).^2);
H = [zeros(3), eye(3), zeros(3); ...
     zeros(3), zeros(3), eye(3); ...
     eye(3), zeros(3), zeros(3)];

etaHat = zeros(N, 3);
nuHat = zeros(N, 3);
accHat = zeros(N, 3);
omegaHat = zeros(N, 3);
qHat = zeros(N, 4);
etaReference = zeros(N, 3);
nuReference = zeros(N, 3);
accReference = zeros(N, 3);
nisHistory = zeros(N, 1);
updated = false(N, 1);
PdiagHistory = zeros(N, 9);

%% 5. ESKF 主循环
for k = 1:N
    [etaRef, nuRef, accRef, ~] = sineTrajectory(t(k), sine);
    etaReference(k, :) = etaRef';
    nuReference(k, :) = nuRef';
    accReference(k, :) = accRef';

    if k > 1
        dt = t(k) - t(k-1);
        eta = quat2eulZYX(q);
        [E, Edot] = eulerRateMatrix(eta, nu);
        omega = E*nu;                         % 机体系角速度
        alpha = E*acc + Edot*nu;              % 机体系角加速度
        [~, ~, ~, jerk] = sineTrajectory(t(k-1), sine);

        % 正弦模型通过三阶导数 jerk 驱动速度和加速度；
        % 姿态使用机体系角速度/角加速度进行二阶四元数积分。
        deltaTheta = omega*dt + 0.5*alpha*dt^2;
        q = quatNormalize(quatMultiply(q, quatExp(deltaTheta)));
        nu = nu + acc*dt + 0.5*jerk*dt^2;
        acc = acc + jerk*dt;

        % 误差状态线性化转移矩阵
        F = eye(9);
        F(1:3, 1:3) = eye(3) - skew(omega)*dt;
        F(1:3, 4:6) = E*dt;
        F(1:3, 7:9) = 0.5*E*dt^2;
        F(4:6, 7:9) = eye(3)*dt;

        % 连续白 jerk 噪声的离散协方差（对姿态块作 E 的局部映射）
        D = diag(((pi/180)*cfg.jerkSpectralDegS3).^2);
        Q = zeros(9, 9);
        Q(1:3, 1:3) = E*D*E' * dt^5/20;
        Q(1:3, 4:6) = E*D * dt^4/8;
        Q(1:3, 7:9) = E*D * dt^3/6;
        Q(4:6, 1:3) = Q(1:3, 4:6)';
        Q(4:6, 4:6) = D * dt^3/3;
        Q(4:6, 7:9) = D * dt^2/2;
        Q(7:9, 1:3) = Q(1:3, 7:9)';
        Q(7:9, 4:6) = Q(4:6, 7:9)';
        Q(7:9, 7:9) = D * dt;
        P = F*P*F' + Q;
        P = 0.5*(P + P');
    end

    % 量测残差：角速度、角加速度，以及 q_pred^-1 (x) q_meas 的旋转向量
    qMeas = eul2quatZYX(etaMeas(k, :)');
    qError = quatMultiply(quatConjugate(q), qMeas);
    angleResidual = quatLog(qError);
    residual = [nuMeas(k, :)' - nu; ...
                accMeas(k, :)' - acc; ...
                angleResidual];

    S = H*P*H' + R;
    nis = residual' * (S \ residual);
    nisHistory(k) = nis;
    allowUpdate = ~cfg.useInnovationGate || k <= cfg.gateWarmup || nis <= cfg.nisGate;

    if allowUpdate
        K = P*H'/S;
        dx = K*residual;

        % Joseph 形式提高数值稳定性
        IKH = eye(9) - K*H;
        P = IKH*P*IKH' + K*R*K';

        % 将误差注入名义状态，随后误差状态归零
        q = quatNormalize(quatMultiply(q, quatExp(dx(1:3))));
        nu = nu + dx(4:6);
        acc = acc + dx(7:9);

        % 姿态误差复位的一阶协方差修正
        Greset = eye(9);
        Greset(1:3, 1:3) = eye(3) - 0.5*skew(dx(1:3));
        P = Greset*P*Greset';
        P = 0.5*(P + P');
        updated(k) = true;
    end

    etaNow = quat2eulZYX(q);
    Enow = eulerRateMatrix(etaNow, nu);
    etaHat(k, :) = etaNow';
    nuHat(k, :) = nu';
    accHat(k, :) = acc';
    omegaHat(k, :) = (Enow*nu)';
    qHat(k, :) = q';
    PdiagHistory(k, :) = diag(P)';
end

%% 6. 导出结果
r2d = 180/pi;
results = table(t, ...
    etaHat(:, 1)*r2d, etaHat(:, 2)*r2d, etaHat(:, 3)*r2d, ...
    nuHat(:, 1)*r2d, nuHat(:, 2)*r2d, nuHat(:, 3)*r2d, ...
    accHat(:, 1)*r2d, accHat(:, 2)*r2d, accHat(:, 3)*r2d, ...
    omegaHat(:, 1)*r2d, omegaHat(:, 2)*r2d, omegaHat(:, 3)*r2d, ...
    qHat(:, 1), qHat(:, 2), qHat(:, 3), qHat(:, 4), ...
    nisHistory, updated, ...
    'VariableNames', {'elapsed_s', ...
    'roll_est_deg', 'pitch_est_deg', 'yaw_est_deg', ...
    'roll_rate_est_deg_s', 'pitch_rate_est_deg_s', 'yaw_rate_est_deg_s', ...
    'roll_accel_est_deg_s2', 'pitch_accel_est_deg_s2', 'yaw_accel_est_deg_s2', ...
    'body_wx_est_deg_s', 'body_wy_est_deg_s', 'body_wz_est_deg_s', ...
    'q_w', 'q_x', 'q_y', 'q_z', 'NIS', 'measurement_updated'});
writetable(results, outputFile);
fprintf('滤波完成：%d/%d 个时刻执行量测更新，结果已写入 %s\n', ...
    nnz(updated), N, outputFile);

%% 7. 绘图：量测、正弦参考和 EKF 估计
figure('Color', 'w', 'Name', '云台三轴 EKF 姿态估计');
for j = 1:3
    subplot(3, 3, j);
    plot(t, etaMeas(:, j)*r2d, 'k.', 'MarkerSize', 8); hold on;
    plot(t, etaReference(:, j)*r2d, ':', 'LineWidth', 1.2);
    plot(t, etaHat(:, j)*r2d, 'LineWidth', 1.5);
    grid on; ylabel('角度 (deg)');
    title([axisNames{j}, ' 角度']);
    if j == 1
        legend('量测', '正弦参考', 'EKF', 'Location', 'best');
    end

    subplot(3, 3, 3+j);
    plot(t, nuMeas(:, j)*r2d, 'k.', 'MarkerSize', 8); hold on;
    plot(t, nuReference(:, j)*r2d, ':', 'LineWidth', 1.2);
    plot(t, nuHat(:, j)*r2d, 'LineWidth', 1.5);
    grid on; ylabel('角速度 (deg/s)');
    title([axisNames{j}, ' 欧拉角速度']);

    subplot(3, 3, 6+j);
    plot(t, accMeas(:, j)*r2d, 'k.', 'MarkerSize', 8); hold on;
    plot(t, accReference(:, j)*r2d, ':', 'LineWidth', 1.2);
    plot(t, accHat(:, j)*r2d, 'LineWidth', 1.5);
    grid on; ylabel('角加速度 (deg/s^2)'); xlabel('时间 (s)');
    title([axisNames{j}, ' 欧拉角加速度']);
end

figure('Color', 'w', 'Name', '新息一致性检验');
semilogy(t, max(nisHistory, eps), 'o-'); hold on;
yline(cfg.nisGate, '--', 'NIS 门限');
grid on; xlabel('时间 (s)'); ylabel('NIS');
title('联合新息平方；被门限拦截的样本不执行量测更新');

%% ========================= 局部函数 =========================
function sine = configureSineModel(t, etaMeas, cfg)
% 已知 Omega 时，A、phi、C 可由线性最小二乘求得：
% y = a*sin(Omega*t) + b*cos(Omega*t) + C。
    sine.Omega = cfg.Omega;
    sine.A = zeros(3, 1);
    sine.phi = zeros(3, 1);
    sine.C = zeros(3, 1);

    if ~cfg.autoFitSine
        sine.A = (pi/180)*cfg.manualAmplitudeDeg;
        sine.C = (pi/180)*cfg.manualOffsetDeg;
        sine.phi = cfg.manualPhaseRad;
        return;
    end

    for j = 1:3
        mask = isfinite(t) & isfinite(etaMeas(:, j));
        if cfg.fitSkipFirstRow
            mask(1) = false;
        end
        tt = t(mask);
        y = etaMeas(mask, j)*180/pi;
        M = [sin(cfg.Omega*tt), cos(cfg.Omega*tt), ones(size(tt))];
        coef = M\y;
        sine.A(j) = hypot(coef(1), coef(2))*pi/180;
        sine.phi(j) = atan2(coef(2), coef(1));
        sine.C(j) = coef(3)*pi/180;
    end
end

function [eta, nu, acc, jerk] = sineTrajectory(t, sine)
% eta = [roll; pitch; yaw]，正弦模型的解析一至三阶导数。
    phase = sine.Omega*t + sine.phi;
    eta = sine.C + sine.A.*sin(phase);
    nu = sine.A.*sine.Omega.*cos(phase);
    acc = -sine.A.*sine.Omega.^2.*sin(phase);
    jerk = -sine.A.*sine.Omega.^3.*cos(phase);
end

function [E, Edot] = eulerRateMatrix(eta, nu)
% ZYX 欧拉角速度到机体系角速度：omega_body = E*nu。
% eta = [roll; pitch; yaw]，nu = [roll_dot; pitch_dot; yaw_dot]。
    roll = eta(1); pitch = eta(2);
    rollDot = nu(1); pitchDot = nu(2);
    sr = sin(roll); cr = cos(roll);
    sp = sin(pitch); cp = cos(pitch);

    E = [1, 0, -sp;
         0, cr, sr*cp;
         0, -sr, cr*cp];
    Edot = [0, 0, -cp*pitchDot;
            0, -sr*rollDot, cr*cp*rollDot - sr*sp*pitchDot;
            0, -cr*rollDot, -sr*cp*rollDot - cr*sp*pitchDot];
end

function q = eul2quatZYX(eta)
% Z-Y-X 欧拉角转 [w;x;y;z] 四元数。
    roll = eta(1); pitch = eta(2); yaw = eta(3);
    cr = cos(roll/2); sr = sin(roll/2);
    cp = cos(pitch/2); sp = sin(pitch/2);
    cy = cos(yaw/2); sy = sin(yaw/2);
    q = [cr*cp*cy + sr*sp*sy;
         sr*cp*cy - cr*sp*sy;
         cr*sp*cy + sr*cp*sy;
         cr*cp*sy - sr*sp*cy];
    q = quatNormalize(q);
end

function eta = quat2eulZYX(q)
% [w;x;y;z] 四元数转 ZYX 欧拉角 [roll;pitch;yaw]。
    q = quatNormalize(q);
    w = q(1); x = q(2); y = q(3); z = q(4);
    roll = atan2(2*(w*x + y*z), 1 - 2*(x^2 + y^2));
    sinPitch = 2*(w*y - z*x);
    sinPitch = min(1, max(-1, sinPitch));
    pitch = asin(sinPitch);
    yaw = atan2(2*(w*z + x*y), 1 - 2*(y^2 + z^2));
    eta = [roll; pitch; yaw];
end

function r = quatMultiply(q, p)
% Hamilton 四元数乘法 q (x) p，标量在前。
    q0 = q(1); qv = q(2:4);
    p0 = p(1); pv = p(2:4);
    r = [q0*p0 - qv'*pv;
         q0*pv + p0*qv + cross(qv, pv)];
end

function qc = quatConjugate(q)
    qc = [q(1); -q(2:4)];
end

function dq = quatExp(rotvec)
% 小旋转向量到单位四元数；零角度附近使用 Taylor 近似。
    angle = norm(rotvec);
    if angle < 1e-8
        dq = [1 - angle^2/8; 0.5*(1 - angle^2/24)*rotvec];
    else
        half = 0.5*angle;
        dq = [cos(half); sin(half)/angle*rotvec];
    end
    dq = quatNormalize(dq);
end

function rotvec = quatLog(q)
% 单位四元数到旋转向量，并选择 q0 >= 0 的最短旋转分支。
    q = quatNormalize(q);
    if q(1) < 0
        q = -q;
    end
    v = q(2:4);
    nv = norm(v);
    if nv < 1e-10
        rotvec = 2*v;
    else
        rotvec = 2*atan2(nv, q(1))/nv*v;
    end
end

function q = quatNormalize(q)
    nq = norm(q);
    assert(nq > eps && isfinite(nq), '四元数范数异常。');
    q = q/nq;
end

function S = skew(v)
    S = [0, -v(3), v(2);
         v(3), 0, -v(1);
         -v(2), v(1), 0];
end