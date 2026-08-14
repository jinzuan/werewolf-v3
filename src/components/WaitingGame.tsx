import { useState, useEffect } from 'react';
import { X, RotateCcw, Trophy, Star } from 'lucide-react';

interface WaitingGameProps {
  onClose: () => void;
}

interface Card {
  id: number;
  symbol: string;
  isFlipped: boolean;
  isMatched: boolean;
}

const SYMBOLS = ['🐺', '🔮', '🧙', '🔫', '👤', '🌙', '☀️', '🗳️'];

export const WaitingGame = ({ onClose }: WaitingGameProps) => {
  const [cards, setCards] = useState<Card[]>([]);
  const [flippedCards, setFlippedCards] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  const [matches, setMatches] = useState(0);
  const [isLocked, setIsLocked] = useState(false);
  const [gameWon, setGameWon] = useState(false);
  const [stars, setStars] = useState(3);

  useEffect(() => {
    shuffleCards();
  }, []);

  useEffect(() => {
    if (matches === SYMBOLS.length) {
      setGameWon(true);
      if (moves <= 12) {
        setStars(3);
      } else if (moves <= 18) {
        setStars(2);
      } else {
        setStars(1);
      }
    }
  }, [matches, moves]);

  const shuffleCards = () => {
    const shuffled = [...SYMBOLS, ...SYMBOLS]
      .map((symbol, index) => ({
        id: index,
        symbol,
        isFlipped: false,
        isMatched: false,
      }))
      .sort(() => Math.random() - 0.5);
    setCards(shuffled);
    setFlippedCards([]);
    setMoves(0);
    setMatches(0);
    setIsLocked(false);
    setGameWon(false);
    setStars(3);
  };

  const handleCardClick = (cardId: number) => {
    if (isLocked) return;
    if (flippedCards.includes(cardId)) return;
    if (cards[cardId].isMatched) return;
    if (flippedCards.length >= 2) return;

    const newFlipped = [...flippedCards, cardId];
    setFlippedCards(newFlipped);

    if (newFlipped.length === 2) {
      setMoves(prev => prev + 1);
      setIsLocked(true);

      const [first, second] = newFlipped;
      if (cards[first].symbol === cards[second].symbol) {
        setTimeout(() => {
          setCards(prev =>
            prev.map(card =>
              card.id === first || card.id === second
                ? { ...card, isMatched: true, isFlipped: true }
                : card
            )
          );
          setMatches(prev => prev + 1);
          setFlippedCards([]);
          setIsLocked(false);
        }, 500);
      } else {
        setTimeout(() => {
          setCards(prev =>
            prev.map(card =>
              card.id === first || card.id === second
                ? { ...card, isFlipped: false }
                : card
            )
          );
          setFlippedCards([]);
          setIsLocked(false);
        }, 1000);
      }
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="card-glass p-6 max-w-lg w-full animate-fade-in">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-yellow-500/30 to-amber-500/20 flex items-center justify-center">
              <Trophy className="w-5 h-5 text-yellow-400" />
            </div>
            <h3 className="text-xl font-bold text-gradient">记忆翻牌游戏</h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-white/5 transition-all"
          >
            <X className="w-5 h-5 text-wolf-text/50" />
          </button>
        </div>

        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-1">
            {[1, 2, 3].map(star => (
              <Star
                key={star}
                className={`w-5 h-5 ${
                  star <= stars ? 'text-yellow-400 fill-yellow-400' : 'text-wolf-text/30'
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-wolf-text/70">
              步数: <span className="text-wolf-text font-medium">{moves}</span>
            </span>
            <span className="text-wolf-text/70">
              配对: <span className="text-wolf-text font-medium">{matches}/{SYMBOLS.length}</span>
            </span>
          </div>
        </div>

        {gameWon ? (
          <div className="text-center py-8">
            <div className="relative inline-block mb-4">
              <div className="absolute inset-0 bg-yellow-500/30 rounded-full blur-xl animate-pulse" />
              <div className="relative w-24 h-24 bg-gradient-to-br from-yellow-500/20 to-amber-500/10 rounded-full flex items-center justify-center">
                <Trophy className="w-12 h-12 text-yellow-400" />
              </div>
            </div>
            <h2 className="text-2xl font-bold text-wolf-text mb-2">恭喜通关！</h2>
            <p className="text-wolf-text/70 mb-4">
              你用了 <span className="text-wolf-purple-light font-bold">{moves}</span> 步完成游戏
            </p>
            <div className="flex justify-center gap-1 mb-6">
              {[1, 2, 3].map(star => (
                <Star
                  key={star}
                  className={`w-8 h-8 ${
                    star <= stars ? 'text-yellow-400 fill-yellow-400' : 'text-wolf-text/30'
                  }`}
                />
              ))}
            </div>
            <button
              onClick={shuffleCards}
              className="btn-primary flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              再玩一次
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-3">
            {cards.map(card => (
              <button
                key={card.id}
                onClick={() => handleCardClick(card.id)}
                disabled={card.isMatched || isLocked || flippedCards.includes(card.id)}
                className={`aspect-square rounded-xl transition-all duration-300 transform ${
                  card.isFlipped || card.isMatched
                    ? 'rotate-y-0'
                    : 'rotate-y-180 hover:scale-105'
                } ${card.isMatched ? 'opacity-60' : ''}`}
                style={{
                  background: card.isFlipped || card.isMatched
                    ? 'linear-gradient(135deg, rgba(107, 33, 168, 0.3) 0%, rgba(124, 58, 237, 0.2) 100%)'
                    : 'linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.05) 100%)',
                  border: `1px solid ${card.isFlipped || card.isMatched ? 'rgba(139, 92, 246, 0.4)' : 'rgba(255, 255, 255, 0.1)'}`,
                  boxShadow: card.isFlipped || card.isMatched
                    ? '0 4px 20px rgba(107, 33, 168, 0.3)'
                    : '0 4px 15px rgba(0, 0, 0, 0.2)',
                }}
              >
                <span className={`text-3xl transition-all ${
                  card.isFlipped || card.isMatched ? 'opacity-100 scale-100' : 'opacity-0 scale-0'
                }`}>
                  {card.symbol}
                </span>
                {!card.isFlipped && !card.isMatched && (
                  <span className="text-3xl text-wolf-text/30">❓</span>
                )}
              </button>
            ))}
          </div>
        )}

        <button
          onClick={shuffleCards}
          className="w-full mt-4 py-3 rounded-xl bg-white/5 hover:bg-white/10 text-wolf-text/70 hover:text-wolf-text font-medium transition-all flex items-center justify-center gap-2"
        >
          <RotateCcw className="w-4 h-4" />
          重新开始
        </button>
      </div>
    </div>
  );
};
