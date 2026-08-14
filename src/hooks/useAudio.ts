import { useCallback, useEffect, useRef } from 'react';

export function useAudio(enabled = true) {
  const previousTurn = useRef(false);
  const notifyTurn = useCallback((isTurn: boolean) => {
    if (!enabled || !isTurn || previousTurn.current) {
      previousTurn.current = isTurn;
      return;
    }
    previousTurn.current = true;
    try {
      const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;
      const context = new AudioContextCtor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.2);
    } catch {
      // 浏览器未允许音频时，视觉提醒仍然有效。
    }
  }, [enabled]);
  useEffect(() => () => { previousTurn.current = false; }, []);
  return { notifyTurn };
}
