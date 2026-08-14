import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../stores/gameStore';

interface DynamicBackgroundProps {
  phase: string | undefined;
}

interface TransitionState {
  isTransitioning: boolean;
  fromDay: boolean;
  progress: number;
}

interface Star {
  id: number;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
  brightness: number;
}

interface Cloud {
  id: number;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
  opacity: number;
}

interface ShootingStar {
  id: number;
  x: number;
  y: number;
  length: number;
  speed: number;
  delay: number;
  active: boolean;
}

interface Building {
  x: number;
  width: number;
  height: number;
  color: string;
  hasChimney: boolean;
  windows: { x: number; y: number; lit: boolean }[];
}

export const DynamicBackground = ({ phase }: DynamicBackgroundProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [transition, setTransition] = useState<TransitionState>({
    isTransitioning: false,
    fromDay: false,
    progress: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    resize();
    window.addEventListener('resize', resize);

    let isDay = phase === 'day';

    const stars: Star[] = Array.from({ length: 150 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 60,
      size: Math.random() * 2 + 0.5,
      delay: Math.random() * 5,
      duration: Math.random() * 3 + 2,
      brightness: Math.random() * 0.5 + 0.5,
    }));

    const clouds: Cloud[] = Array.from({ length: 12 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 40 + 5,
      size: Math.random() * 40 + 30,
      delay: Math.random() * 40,
      duration: Math.random() * 40 + 50,
      opacity: isDay ? Math.random() * 0.4 + 0.3 : Math.random() * 0.15 + 0.05,
    }));

    const shootingStars: ShootingStar[] = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 30,
      length: Math.random() * 80 + 60,
      speed: Math.random() * 0.02 + 0.015,
      delay: Math.random() * 15000 + 5000,
      active: false,
    }));

    const buildings: Building[] = [
      { x: 5, width: 6, height: 12, color: '#2d2d3a', hasChimney: true, windows: [{ x: 1, y: 3, lit: true }, { x: 4, y: 3, lit: true }, { x: 1, y: 7, lit: false }, { x: 4, y: 7, lit: true }] },
      { x: 13, width: 8, height: 18, color: '#3d3d4a', hasChimney: false, windows: [{ x: 1, y: 3, lit: true }, { x: 4, y: 3, lit: false }, { x: 6, y: 3, lit: true }, { x: 1, y: 8, lit: true }, { x: 4, y: 8, lit: true }, { x: 6, y: 8, lit: false }, { x: 1, y: 13, lit: true }, { x: 4, y: 13, lit: true }] },
      { x: 23, width: 10, height: 22, color: '#4a4a5a', hasChimney: true, windows: [{ x: 1, y: 3, lit: true }, { x: 4, y: 3, lit: true }, { x: 7, y: 3, lit: false }, { x: 1, y: 9, lit: true }, { x: 4, y: 9, lit: false }, { x: 7, y: 9, lit: true }, { x: 1, y: 15, lit: true }, { x: 4, y: 15, lit: true }, { x: 7, y: 15, lit: true }] },
      { x: 35, width: 7, height: 15, color: '#3d3d4a', hasChimney: false, windows: [{ x: 1, y: 4, lit: false }, { x: 4, y: 4, lit: true }, { x: 1, y: 9, lit: true }, { x: 4, y: 9, lit: false }] },
      { x: 44, width: 9, height: 20, color: '#2d2d3a', hasChimney: true, windows: [{ x: 1, y: 4, lit: true }, { x: 4, y: 4, lit: true }, { x: 7, y: 4, lit: true }, { x: 1, y: 10, lit: false }, { x: 4, y: 10, lit: true }, { x: 7, y: 10, lit: false }, { x: 1, y: 16, lit: true }, { x: 4, y: 16, lit: true }] },
      { x: 55, width: 8, height: 16, color: '#4a4a5a', hasChimney: false, windows: [{ x: 1, y: 5, lit: true }, { x: 5, y: 5, lit: true }, { x: 1, y: 10, lit: false }, { x: 5, y: 10, lit: true }] },
      { x: 65, width: 11, height: 24, color: '#3d3d4a', hasChimney: true, windows: [{ x: 1, y: 3, lit: true }, { x: 5, y: 3, lit: false }, { x: 8, y: 3, lit: true }, { x: 1, y: 9, lit: true }, { x: 5, y: 9, lit: true }, { x: 8, y: 9, lit: true }, { x: 1, y: 15, lit: false }, { x: 5, y: 15, lit: true }, { x: 8, y: 15, lit: false }, { x: 1, y: 20, lit: true }, { x: 5, y: 20, lit: true }] },
      { x: 78, width: 7, height: 14, color: '#2d2d3a', hasChimney: false, windows: [{ x: 1, y: 4, lit: true }, { x: 4, y: 4, lit: false }, { x: 1, y: 9, lit: true }, { x: 4, y: 9, lit: true }] },
      { x: 87, width: 10, height: 19, color: '#4a4a5a', hasChimney: true, windows: [{ x: 1, y: 4, lit: false }, { x: 5, y: 4, lit: true }, { x: 8, y: 4, lit: true }, { x: 1, y: 10, lit: true }, { x: 5, y: 10, lit: false }, { x: 8, y: 10, lit: true }, { x: 1, y: 15, lit: true }, { x: 5, y: 15, lit: true }] },
    ];

    let animationId: number;
    let time = 0;
    let lastShootingStarTime = 0;

    const drawSkyGradient = () => {
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      if (isDay) {
        gradient.addColorStop(0, '#4a90c2');
        gradient.addColorStop(0.3, '#7bc4e8');
        gradient.addColorStop(0.6, '#b8e0f5');
        gradient.addColorStop(1, '#e8f4fc');
      } else {
        gradient.addColorStop(0, '#0a0a15');
        gradient.addColorStop(0.3, '#1a1a2e');
        gradient.addColorStop(0.6, '#16213e');
        gradient.addColorStop(1, '#0f3460');
      }
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    };

    const drawSun = () => {
      const centerX = canvas.width * 0.75;
      const centerY = canvas.height * 0.2;
      const radius = Math.min(canvas.width, canvas.height) * 0.12;

      const glowGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 2.5);
      glowGradient.addColorStop(0, 'rgba(255, 200, 100, 0.6)');
      glowGradient.addColorStop(0.3, 'rgba(255, 200, 100, 0.3)');
      glowGradient.addColorStop(0.6, 'rgba(255, 200, 100, 0.1)');
      glowGradient.addColorStop(1, 'rgba(255, 200, 100, 0)');

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = glowGradient;
      ctx.fill();

      const sunGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
      sunGradient.addColorStop(0, '#fff9e6');
      sunGradient.addColorStop(0.4, '#ffe8a0');
      sunGradient.addColorStop(0.7, '#ffd966');
      sunGradient.addColorStop(1, '#ffc700');

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fillStyle = sunGradient;
      ctx.fill();

      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2 + time * 0.1;
        const innerRadius = radius * 1.15;
        const outerRadius = radius * 1.45;
        const x1 = centerX + Math.cos(angle) * innerRadius;
        const y1 = centerY + Math.sin(angle) * innerRadius;
        const x2 = centerX + Math.cos(angle) * outerRadius;
        const y2 = centerY + Math.sin(angle) * outerRadius;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = `rgba(255, 200, 100, ${0.25 + Math.sin(time * 2 + i) * 0.15})`;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    };

    const drawMoon = () => {
      const centerX = canvas.width * 0.8;
      const centerY = canvas.height * 0.18;
      const radius = Math.min(canvas.width, canvas.height) * 0.09;
      const moonPhase = (time * 0.02) % (Math.PI * 2);

      const glowGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 3);
      glowGradient.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
      glowGradient.addColorStop(0.3, 'rgba(200, 200, 255, 0.15)');
      glowGradient.addColorStop(0.6, 'rgba(150, 150, 255, 0.06)');
      glowGradient.addColorStop(1, 'rgba(100, 100, 200, 0)');

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius * 3, 0, Math.PI * 2);
      ctx.fillStyle = glowGradient;
      ctx.fill();

      const moonGradient = ctx.createRadialGradient(centerX - radius * 0.25, centerY - radius * 0.25, 0, centerX, centerY, radius);
      moonGradient.addColorStop(0, '#fefefe');
      moonGradient.addColorStop(0.5, '#e8e8f0');
      moonGradient.addColorStop(1, '#d0d0de');

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fillStyle = moonGradient;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(centerX + Math.cos(moonPhase) * radius * 0.8, centerY + Math.sin(moonPhase) * radius * 0.8, radius * 0.95, 0, Math.PI * 2);
      ctx.fillStyle = isDay ? 'transparent' : '#0a0a15';
      ctx.fill();

      const craterPositions = [
        { x: -0.22, y: -0.12, r: 0.15, brightness: 0.8 },
        { x: 0.32, y: 0.18, r: 0.11, brightness: 0.75 },
        { x: -0.08, y: 0.32, r: 0.13, brightness: 0.78 },
        { x: 0.22, y: -0.28, r: 0.09, brightness: 0.82 },
        { x: -0.35, y: 0.05, r: 0.07, brightness: 0.85 },
      ];

      craterPositions.forEach(crater => {
        const cx = centerX + crater.x * radius;
        const cy = centerY + crater.y * radius;
        const cr = crater.r * radius;

        const craterGradient = ctx.createRadialGradient(cx - cr * 0.25, cy - cr * 0.25, 0, cx, cy, cr);
        craterGradient.addColorStop(0, `rgba(200, 200, 210, ${crater.brightness})`);
        craterGradient.addColorStop(1, 'rgba(140, 140, 160, 0.6)');

        ctx.beginPath();
        ctx.arc(cx, cy, cr, 0, Math.PI * 2);
        ctx.fillStyle = craterGradient;
        ctx.fill();
      });
    };

    const drawStars = () => {
      if (isDay) return;

      stars.forEach(star => {
        const twinkle = Math.sin(time * 2.5 + star.delay) * 0.4 + 0.6;
        const alpha = star.brightness * twinkle * (0.4 + Math.sin(time + star.id) * 0.3);

        ctx.beginPath();
        ctx.arc(
          (star.x / 100) * canvas.width,
          (star.y / 100) * canvas.height,
          star.size * alpha,
          0,
          Math.PI * 2
        );

        const starGlow = ctx.createRadialGradient(
          (star.x / 100) * canvas.width,
          (star.y / 100) * canvas.height,
          0,
          (star.x / 100) * canvas.width,
          (star.y / 100) * canvas.height,
          star.size * 3
        );
        starGlow.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
        starGlow.addColorStop(0.5, `rgba(200, 200, 255, ${alpha * 0.3})`);
        starGlow.addColorStop(1, 'rgba(200, 200, 255, 0)');

        ctx.fillStyle = starGlow;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(
          (star.x / 100) * canvas.width,
          (star.y / 100) * canvas.height,
          star.size * 0.5 * alpha,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.fill();
      });
    };

    const drawClouds = () => {
      clouds.forEach(cloud => {
        const x = ((cloud.x + (time / cloud.duration) * 100) % 130 - 15) / 100 * canvas.width;
        const y = (cloud.y / 100) * canvas.height;
        const size = (cloud.size / 100) * Math.min(canvas.width, canvas.height);

        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(x - size * 0.35, y - size * 0.18, x - size * 0.55, y, x - size * 0.35, y + size * 0.12);
        ctx.bezierCurveTo(x - size * 0.05, y + size * 0.3, x + size * 0.1, y + size * 0.25, x + size * 0.35, y + size * 0.12);
        ctx.bezierCurveTo(x + size * 0.55, y - size * 0.18, x + size * 0.35, y - size * 0.12, x, y);

        const cloudGradient = ctx.createRadialGradient(x, y - size * 0.1, 0, x, y, size * 0.5);
        
        if (isDay) {
          cloudGradient.addColorStop(0, `rgba(255, 255, 255, ${cloud.opacity})`);
          cloudGradient.addColorStop(1, `rgba(230, 230, 240, ${cloud.opacity * 0.7})`);
        } else {
          cloudGradient.addColorStop(0, `rgba(200, 200, 220, ${cloud.opacity})`);
          cloudGradient.addColorStop(1, `rgba(150, 150, 180, ${cloud.opacity * 0.5})`);
        }

        ctx.fillStyle = cloudGradient;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(x + size * 0.1, y - size * 0.05);
        ctx.bezierCurveTo(x + size * 0.05, y - size * 0.2, x + size * 0.25, y - size * 0.22, x + size * 0.4, y - size * 0.1);
        ctx.bezierCurveTo(x + size * 0.55, y - size * 0.08, x + size * 0.5, y + size * 0.05, x + size * 0.35, y + size * 0.08);
        ctx.closePath();
        ctx.fillStyle = isDay ? `rgba(255, 255, 255, ${cloud.opacity * 0.8})` : `rgba(220, 220, 240, ${cloud.opacity * 0.6})`;
        ctx.fill();
      });
    };

    const drawShootingStars = () => {
      if (isDay) return;

      const currentTime = time * 1000;
      shootingStars.forEach(shootingStar => {
        if (!shootingStar.active && currentTime - lastShootingStarTime > shootingStar.delay) {
          shootingStar.active = true;
          shootingStar.x = Math.random() * canvas.width;
          shootingStar.y = Math.random() * canvas.height * 0.4;
          lastShootingStarTime = currentTime;
        }

        if (shootingStar.active) {
          const endX = shootingStar.x + Math.cos(-Math.PI / 4) * shootingStar.length;
          const endY = shootingStar.y + Math.sin(-Math.PI / 4) * shootingStar.length;

          const gradient = ctx.createLinearGradient(shootingStar.x, shootingStar.y, endX, endY);
          gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
          gradient.addColorStop(0.3, 'rgba(200, 220, 255, 0.9)');
          gradient.addColorStop(0.7, 'rgba(150, 180, 255, 0.6)');
          gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

          ctx.beginPath();
          ctx.moveTo(shootingStar.x, shootingStar.y);
          ctx.lineTo(endX, endY);
          ctx.strokeStyle = gradient;
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(shootingStar.x, shootingStar.y, 2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
          ctx.fill();

          shootingStar.x += Math.cos(-Math.PI / 4) * shootingStar.speed * 100;
          shootingStar.y += Math.sin(-Math.PI / 4) * shootingStar.speed * 100;

          if (shootingStar.x > canvas.width + 100 || shootingStar.y > canvas.height + 100) {
            shootingStar.active = false;
          }
        }
      });
    };

    const drawVillage = () => {
      const groundY = canvas.height * 0.85;
      const buildingScale = canvas.width / 100;

      const groundGradient = ctx.createLinearGradient(0, groundY, 0, canvas.height);
      if (isDay) {
        groundGradient.addColorStop(0, '#6b8e4e');
        groundGradient.addColorStop(1, '#4a6b3a');
      } else {
        groundGradient.addColorStop(0, '#2a3a22');
        groundGradient.addColorStop(1, '#1a2518');
      }
      ctx.fillStyle = groundGradient;
      ctx.fillRect(0, groundY, canvas.width, canvas.height - groundY);

      buildings.forEach(building => {
        const buildingX = building.x * buildingScale;
        const buildingWidth = building.width * buildingScale;
        const buildingHeight = building.height * buildingScale * 0.8;
        const buildingY = groundY - buildingHeight;

        ctx.fillStyle = building.color;
        ctx.fillRect(buildingX, buildingY, buildingWidth, buildingHeight);

        ctx.beginPath();
        ctx.moveTo(buildingX, buildingY);
        ctx.lineTo(buildingX + buildingWidth / 2, buildingY - buildingHeight * 0.35);
        ctx.lineTo(buildingX + buildingWidth, buildingY);
        ctx.closePath();
        ctx.fillStyle = isDay ? '#5a5a6a' : '#3a3a4a';
        ctx.fill();

        if (building.hasChimney) {
          const chimneyX = buildingX + buildingWidth * 0.7;
          const chimneyWidth = buildingWidth * 0.12;
          const chimneyHeight = buildingHeight * 0.25;
          
          ctx.fillStyle = isDay ? '#5a4a4a' : '#3a2a2a';
          ctx.fillRect(chimneyX, buildingY - chimneyHeight, chimneyWidth, chimneyHeight);

          if (!isDay && Math.random() > 0.5) {
            const smokeX = chimneyX + chimneyWidth / 2;
            const smokeY = buildingY - chimneyHeight - 10;
            
            ctx.beginPath();
            ctx.arc(smokeX, smokeY, 8, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(100, 100, 100, 0.4)';
            ctx.fill();

            ctx.beginPath();
            ctx.arc(smokeX + 5, smokeY - 8, 6, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(100, 100, 100, 0.3)';
            ctx.fill();

            ctx.beginPath();
            ctx.arc(smokeX + 10, smokeY - 15, 5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(100, 100, 100, 0.2)';
            ctx.fill();
          }
        }

        building.windows.forEach(window => {
          const windowX = buildingX + window.x * buildingScale * 0.9;
          const windowY = buildingY + window.y * buildingScale * 0.8;
          const windowWidth = buildingScale * 1.5;
          const windowHeight = buildingScale * 2;

          ctx.fillStyle = window.lit && !isDay ? '#ffdd88' : (isDay ? '#87ceeb' : '#2a2a3a');
          ctx.fillRect(windowX, windowY, windowWidth, windowHeight);

          ctx.strokeStyle = isDay ? '#4a4a5a' : '#1a1a2a';
          ctx.lineWidth = 1;
          ctx.strokeRect(windowX, windowY, windowWidth, windowHeight);

          ctx.beginPath();
          ctx.moveTo(windowX + windowWidth / 2, windowY);
          ctx.lineTo(windowX + windowWidth / 2, windowY + windowHeight);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(windowX, windowY + windowHeight / 2);
          ctx.lineTo(windowX + windowWidth, windowY + windowHeight / 2);
          ctx.stroke();
        });
      });

      const treePositions = [18, 30, 48, 62, 72, 92];
      treePositions.forEach(treeX => {
        const x = treeX * buildingScale;
        const treeHeight = buildingScale * 8;
        const treeY = groundY - treeHeight;

        ctx.beginPath();
        ctx.moveTo(x, groundY);
        ctx.lineTo(x + buildingScale * 2, treeY);
        ctx.lineTo(x + buildingScale * 4, groundY);
        ctx.closePath();
        ctx.fillStyle = isDay ? '#2d5a27' : '#1a3517';
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(x + buildingScale * 0.5, groundY);
        ctx.lineTo(x + buildingScale * 2, treeY + buildingScale * 2.5);
        ctx.lineTo(x + buildingScale * 3.5, groundY);
        ctx.closePath();
        ctx.fillStyle = isDay ? '#3d7a37' : '#254522';
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(x + buildingScale * 1, groundY);
        ctx.lineTo(x + buildingScale * 2, treeY + buildingScale * 4.5);
        ctx.lineTo(x + buildingScale * 3, groundY);
        ctx.closePath();
        ctx.fillStyle = isDay ? '#4d9a47' : '#2d5529';
        ctx.fill();

        ctx.fillStyle = '#8b4513';
        ctx.fillRect(x + buildingScale * 1.8, groundY, buildingScale * 0.4, buildingScale * 1.5);
      });
    };

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      drawSkyGradient();

      if (isDay) {
        drawSun();
      } else {
        drawMoon();
        drawStars();
        drawShootingStars();
      }

      drawClouds();
      drawVillage();

      if (!reducedMotion) {
        time += 0.016;
        animationId = requestAnimationFrame(animate);
      }
    };

    animate();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationId);
    };
  }, [phase]);

  useEffect(() => {
    const currentIsDay = phase === 'day';
    if (transition.isTransitioning) return;
    
    setTransition({
      isTransitioning: true,
      fromDay: !currentIsDay,
      progress: 0,
    });

    const startTime = Date.now();
    const duration = 500;

    const animateTransition = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      setTransition(prev => ({
        ...prev,
        progress,
        isTransitioning: progress < 1,
      }));

      if (progress < 1) {
        requestAnimationFrame(animateTransition);
      }
    };

    requestAnimationFrame(animateTransition);
  }, [phase]);

  const isDay = phase === 'day';

  return (
    <>
      <canvas
        ref={canvasRef}
        className="fixed inset-0 pointer-events-none z-0"
        style={{ opacity: 0.7 }}
      />
      <div 
        className="fixed inset-0 pointer-events-none z-0 atmosphere-tint"
        style={{
          background: isDay
            ? 'linear-gradient(180deg, rgba(255, 255, 255, 0.35) 0%, rgba(226, 238, 246, 0.2) 55%, rgba(205, 220, 230, 0.12) 100%)'
            : 'linear-gradient(180deg, rgba(12, 12, 25, 0.78) 0%, rgba(26, 24, 52, 0.68) 50%, rgba(26, 34, 72, 0.58) 100%)',
        }}
      />
      <div 
        className={'fixed inset-0 pointer-events-none z-0 atmosphere-vignette ' + (isDay ? 'atmosphere-vignette--day' : 'atmosphere-vignette--night')}
        style={{
          background: isDay
            ? 'radial-gradient(ellipse 70% 50% at 75% 20%, rgba(255, 200, 100, 0.15) 0%, transparent 50%), radial-gradient(ellipse 50% 40% at 20% 85%, rgba(135, 206, 235, 0.1) 0%, transparent 50%)'
            : 'radial-gradient(ellipse 60% 40% at 80% 18%, rgba(255, 255, 255, 0.08) 0%, transparent 50%), radial-gradient(ellipse 50% 35% at 20% 50%, rgba(107, 33, 168, 0.12) 0%, transparent 50%), radial-gradient(ellipse 40% 30% at 50% 85%, rgba(147, 51, 234, 0.08) 0%, transparent 50%)',
        }}
      />
    </>
  );
};
