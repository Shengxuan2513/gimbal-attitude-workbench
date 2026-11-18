import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildActiveRotationMatrix } from '../math/angles';
import type { RotationOrder } from '../types/attitude';

function createAxisLabelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
  ctx.beginPath();
  ctx.roundRect(8, 8, 144, 48, 12);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.font = 'bold 26px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 80, 33);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.62, 0.25, 1);
  return sprite;
}

function buildAirplaneMesh(): THREE.Group {
  const plane = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    metalness: 0.35,
    roughness: 0.4,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    metalness: 0.25,
    roughness: 0.35,
  });
  const noseMat = new THREE.MeshStandardMaterial({
    color: 0xf97316,
    metalness: 0.2,
    roughness: 0.35,
  });
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    metalness: 0.8,
    roughness: 0.15,
  });
  const leftTipMat = new THREE.MeshStandardMaterial({ color: 0xef4444 });
  const rightTipMat = new THREE.MeshStandardMaterial({ color: 0x22c55e });

  // Fuselage along +X (forward) to -X (tail)
  const fuselageGeo = new THREE.CylinderGeometry(0.11, 0.08, 1.5, 20);
  fuselageGeo.rotateZ(-Math.PI / 2);
  const fuselage = new THREE.Mesh(fuselageGeo, bodyMat);
  plane.add(fuselage);

  // Nose cone (+X)
  const noseGeo = new THREE.ConeGeometry(0.11, 0.42, 20);
  noseGeo.rotateZ(-Math.PI / 2);
  const nose = new THREE.Mesh(noseGeo, noseMat);
  nose.position.set(0.96, 0, 0);
  plane.add(nose);

  // Canopy (+Z top, slightly forward)
  const canopyGeo = new THREE.SphereGeometry(0.115, 16, 12);
  canopyGeo.scale(2.0, 0.72, 0.75);
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.position.set(0.35, 0, 0.085);
  plane.add(canopy);

  // Main Wings along Y (+Y = Left, -Y = Right)
  const wingGeo = new THREE.BoxGeometry(0.38, 2.05, 0.035);
  const wing = new THREE.Mesh(wingGeo, accentMat);
  wing.position.set(0.05, 0, 0.01);
  plane.add(wing);

  // Wingtip markers (+Y left = red, -Y right = green)
  const tipGeo = new THREE.BoxGeometry(0.24, 0.08, 0.05);
  const leftTip = new THREE.Mesh(tipGeo, leftTipMat);
  leftTip.position.set(0.02, 1.05, 0.015);
  plane.add(leftTip);

  const rightTip = new THREE.Mesh(tipGeo, rightTipMat);
  rightTip.position.set(0.02, -1.05, 0.015);
  plane.add(rightTip);

  // Horizontal stabilizer at tail (-X)
  const hStabGeo = new THREE.BoxGeometry(0.22, 0.74, 0.025);
  const hStab = new THREE.Mesh(hStabGeo, accentMat);
  hStab.position.set(-0.66, 0, 0.02);
  plane.add(hStab);

  // Vertical tail fin (+Z)
  const vFinGeo = new THREE.BoxGeometry(0.26, 0.03, 0.36);
  const vFin = new THREE.Mesh(vFinGeo, noseMat);
  vFin.position.set(-0.64, 0, 0.21);
  plane.add(vFin);

  // Body-fixed axes arrows
  const len = 1.25;
  plane.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), len, 0xf87171, 0.16, 0.08));
  plane.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), len, 0x4ade80, 0.16, 0.08));
  plane.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), len * 0.8, 0x60a5fa, 0.16, 0.08));

  return plane;
}

export class Viewport3D {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private planeGroup: THREE.Group;
  private resizeObserver: ResizeObserver;
  private animId = 0;

  constructor(container: HTMLElement) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1120);

    const width = Math.max(container.clientWidth, 300);
    const height = Math.max(container.clientHeight, 240);

    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
    this.camera.position.set(3.1, 2.15, 2.95);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.8;
    this.controls.maxDistance = 9;

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.75);
    this.scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.15);
    dirLight.position.set(4, 6, 4);
    this.scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.45);
    fillLight.position.set(-4, -2, -3);
    this.scene.add(fillLight);

    // Aerospace right-handed world frame: X forward, Y left, Z up
    // Rx(-90°): Aero (X, Y, Z) -> Three (X, Z, -Y), det = +1
    const aeroWorld = new THREE.Group();
    aeroWorld.rotation.x = -Math.PI / 2;
    this.scene.add(aeroWorld);

    // Ground reference grid in Aero X-Y plane (Z = -0.65)
    const grid = new THREE.GridHelper(4.4, 11, 0x334155, 0x1e293b);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.65;
    aeroWorld.add(grid);

    // Fixed world reference axes
    const refLen = 1.65;
    aeroWorld.add(
      new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), refLen, 0xef4444, 0.14, 0.07)
    );
    aeroWorld.add(
      new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), refLen, 0x22c55e, 0.14, 0.07)
    );
    aeroWorld.add(
      new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), refLen * 0.85, 0x3b82f6, 0.14, 0.07)
    );

    const lblX = createAxisLabelSprite('X 前', '#f87171');
    lblX.position.set(1.88, 0, 0);
    aeroWorld.add(lblX);

    const lblY = createAxisLabelSprite('Y 左', '#4ade80');
    lblY.position.set(0, 1.88, 0);
    aeroWorld.add(lblY);

    const lblZ = createAxisLabelSprite('Z 上', '#60a5fa');
    lblZ.position.set(0, 0, 1.62);
    aeroWorld.add(lblZ);

    this.planeGroup = buildAirplaneMesh();
    aeroWorld.add(this.planeGroup);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);

    const animate = () => {
      this.animId = requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  public setAttitude(
    rollDeg: number,
    pitchDeg: number,
    yawDeg: number,
    order: RotationOrder
  ): void {
    const mat = buildActiveRotationMatrix(rollDeg, pitchDeg, yawDeg, order);
    this.planeGroup.quaternion.setFromRotationMatrix(mat);
  }

  public resetCamera(): void {
    this.camera.position.set(3.1, 2.15, 2.95);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private handleResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  public dispose(): void {
    cancelAnimationFrame(this.animId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
