import { X, Save, Info, Bot, Server } from 'lucide-react';
import { useGameStore } from '../stores/gameStore';
import type { PlayerAIConfig } from '../types';
import { AI_DEFAULTS } from '../../shared/config/aiDefaults';

interface SettingsProps {
  onClose: () => void;
}

export const Settings = ({ onClose }: SettingsProps) => {
  const { aiConfig, setAIConfig, players, updatePlayerAIConfig, currentRoom } = useGameStore();

  // 确保 aiConfig 是有效的
  const safeConfig = aiConfig && aiConfig.siliconflow && aiConfig.deepseek && aiConfig.local 
    ? aiConfig 
    : AI_DEFAULTS;

  const handleSave = () => {
    setAIConfig(safeConfig);
    onClose();
  };

  const aiPlayers = currentRoom ? players.filter((p) => p.isAI && p.roomId === currentRoom.id) : [];

  const handlePlayerConfigChange = (playerId: string, key: keyof PlayerAIConfig, value: string | number) => {
    const player = players.find((p) => p.id === playerId);
    const activeConfig = safeConfig.apiType === 'siliconflow'
      ? safeConfig.siliconflow
      : safeConfig.apiType === 'deepseek'
        ? safeConfig.deepseek
        : safeConfig.local;
    const currentConfig = player?.aiConfig || {
      model: activeConfig.model,
      temperature: activeConfig.temperature,
      maxTokens: activeConfig.maxTokens,
      behavior: safeConfig.defaultBehavior,
    };
    
    updatePlayerAIConfig(playerId, {
      ...currentConfig,
      [key]: value,
    });
  };

  const activeConfig = safeConfig.apiType === 'siliconflow'
    ? safeConfig.siliconflow
    : safeConfig.apiType === 'deepseek'
      ? safeConfig.deepseek
      : safeConfig.local;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="card p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-bold text-wolf-text">设置</h3>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-wolf-purple/20 transition-colors"
          >
            <X className="w-5 h-5 text-wolf-text" />
          </button>
        </div>

        <div className="space-y-8">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Info className="w-4 h-4 text-wolf-purple" />
              <h4 className="font-medium text-wolf-text">AI API配置</h4>
            </div>
            <p className="text-sm text-wolf-text/60 mb-4">
              配置AI API以启用AI玩家功能。支持硅基流动API、Deepseek API或本地模型（如LM Studio）。
            </p>

            <div className="mb-4">
              <label className="block text-sm text-wolf-text/70 mb-2">API类型</label>
              <div className="flex gap-3">
                <button
                  onClick={() => setAIConfig({ ...safeConfig, apiType: 'siliconflow' })}
                  className={`flex-1 py-3 rounded-lg border font-medium transition-all ${
                    safeConfig.apiType === 'siliconflow'
                      ? 'bg-purple-500/20 border-purple-500 text-purple-400'
                      : 'bg-wolf-dark/50 border-wolf-purple/30 text-wolf-text/70 hover:border-wolf-purple/50'
                  }`}
                >
                  🌐 硅基流动
                </button>
                <button
                  onClick={() => setAIConfig({ ...safeConfig, apiType: 'deepseek' })}
                  className={`flex-1 py-3 rounded-lg border font-medium transition-all ${
                    safeConfig.apiType === 'deepseek'
                      ? 'bg-blue-500/20 border-blue-500 text-blue-400'
                      : 'bg-wolf-dark/50 border-wolf-purple/30 text-wolf-text/70 hover:border-wolf-purple/50'
                  }`}
                >
                  💎 Deepseek
                </button>
                <button
                  onClick={() => setAIConfig({ ...safeConfig, apiType: 'local' })}
                  className={`flex-1 py-3 rounded-lg border font-medium transition-all ${
                    safeConfig.apiType === 'local'
                      ? 'bg-green-500/20 border-green-500 text-green-400'
                      : 'bg-wolf-dark/50 border-wolf-purple/30 text-wolf-text/70 hover:border-wolf-purple/50'
                  }`}
                >
                  🖥️ 本地模型
                </button>
              </div>
            </div>

            {/* 硅基流动配置 */}
            <div className="mb-6 border border-purple-500/30 rounded-xl p-4 bg-purple-500/5">
              <div className="flex items-center gap-2 mb-3">
                <Server className="w-4 h-4 text-purple-400" />
                <span className="font-medium text-purple-400">硅基流动配置</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">API密钥</label>
                  <input
                    type="password"
                    value={safeConfig.siliconflow.apiKey}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      siliconflow: { ...safeConfig.siliconflow, apiKey: e.target.value }
                    })}
                    placeholder="sk-..."
                    className="w-full input-field"
                  />
                  <p className="text-xs text-wolf-text/50 mt-1">
                    从硅基流动平台获取您的API密钥
                  </p>
                </div>
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">模型名称</label>
                  <input
                    type="text"
                    value={safeConfig.siliconflow.model}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      siliconflow: { ...safeConfig.siliconflow, model: e.target.value }
                    })}
                    placeholder={AI_DEFAULTS.siliconflow.model}
                    className="w-full input-field"
                  />
                </div>
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">
                    温度参数: {safeConfig.siliconflow.temperature}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={safeConfig.siliconflow.temperature}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      siliconflow: { ...safeConfig.siliconflow, temperature: Number(e.target.value) }
                    })}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">
                    最大Tokens: {safeConfig.siliconflow.maxTokens}
                  </label>
                  <input
                    type="range"
                    min="200"
                    max="512"
                    step="1"
                    value={safeConfig.siliconflow.maxTokens}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      siliconflow: { ...safeConfig.siliconflow, maxTokens: Number(e.target.value) }
                    })}
                    className="w-full"
                  />
                </div>
              </div>
            </div>

            {/* Deepseek 配置 */}
            <div className="mb-6 border border-blue-500/30 rounded-xl p-4 bg-blue-500/5">
              <div className="flex items-center gap-2 mb-3">
                <Server className="w-4 h-4 text-blue-400" />
                <span className="font-medium text-blue-400">Deepseek 配置</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">API密钥</label>
                  <input
                    type="password"
                    value={safeConfig.deepseek.apiKey}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      deepseek: { ...safeConfig.deepseek, apiKey: e.target.value }
                    })}
                    placeholder="sk-..."
                    className="w-full input-field"
                  />
                  <p className="text-xs text-wolf-text/50 mt-1">
                    从 Deepseek 平台获取您的API密钥
                  </p>
                </div>
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">模型名称</label>
                  <select
                    value={safeConfig.deepseek.model}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      deepseek: { ...safeConfig.deepseek, model: e.target.value }
                    })}
                    className="w-full input-field"
                  >
                    <option value="deepseek-chat">deepseek-chat（V3 对话模型，推荐）</option>
                    <option value="deepseek-reasoner">deepseek-reasoner（R1 推理模型）</option>
                  </select>
                  <p className="text-xs text-wolf-text/50 mt-1">
                    Flash 版本响应更快，Pro 版本更强大
                  </p>
                </div>
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">
                    温度参数: {safeConfig.deepseek.temperature}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={safeConfig.deepseek.temperature}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      deepseek: { ...safeConfig.deepseek, temperature: Number(e.target.value) }
                    })}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">
                    最大Tokens: {safeConfig.deepseek.maxTokens}
                  </label>
                  <input
                    type="range"
                    min="200"
                    max="512"
                    step="1"
                    value={safeConfig.deepseek.maxTokens}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      deepseek: { ...safeConfig.deepseek, maxTokens: Number(e.target.value) }
                    })}
                    className="w-full"
                  />
                </div>
              </div>
            </div>

            {/* 本地模型配置 */}
            <div className="border border-green-500/30 rounded-xl p-4 bg-green-500/5">
              <div className="flex items-center gap-2 mb-3">
                <Server className="w-4 h-4 text-green-400" />
                <span className="font-medium text-green-400">本地模型配置</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">API地址</label>
                  <input
                    type="text"
                    value={safeConfig.local.apiUrl}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      local: { ...safeConfig.local, apiUrl: e.target.value }
                    })}
                    placeholder={AI_DEFAULTS.local.apiUrl}
                    className="w-full input-field"
                  />
                  <p className="text-xs text-wolf-text/50 mt-1">
                    LM Studio默认地址
                  </p>
                </div>
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">模型名称</label>
                  <input
                    type="text"
                    value={safeConfig.local.model}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      local: { ...safeConfig.local, model: e.target.value }
                    })}
                    placeholder={AI_DEFAULTS.local.model}
                    className="w-full input-field"
                  />
                </div>
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">
                    温度参数: {safeConfig.local.temperature}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={safeConfig.local.temperature}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      local: { ...safeConfig.local, temperature: Number(e.target.value) }
                    })}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm text-wolf-text/70 mb-1">
                    最大Tokens: {safeConfig.local.maxTokens}
                  </label>
                  <input
                    type="range"
                    min="200"
                    max="512"
                    step="1"
                    value={safeConfig.local.maxTokens}
                    onChange={(e) => setAIConfig({
                      ...safeConfig,
                      local: { ...safeConfig.local, maxTokens: Number(e.target.value) }
                    })}
                    className="w-full"
                  />
                </div>
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-3">
              <Bot className="w-4 h-4 text-blue-400" />
              <h4 className="font-medium text-wolf-text">AI行为设置</h4>
            </div>
            <p className="text-sm text-wolf-text/60 mb-4">
              设置AI玩家的默认行为模式，这将影响他们的发言风格和决策方式。
            </p>

            <div>
              <label className="block text-sm text-wolf-text/70 mb-2">默认行为模式</label>
              <div className="flex gap-3">
                <button
                  onClick={() => setAIConfig({ ...safeConfig, defaultBehavior: 'aggressive' })}
                  className={`flex-1 py-3 rounded-lg border font-medium transition-all ${
                    safeConfig.defaultBehavior === 'aggressive'
                      ? 'bg-red-500/20 border-red-500 text-red-400'
                      : 'bg-wolf-dark/50 border-wolf-purple/30 text-wolf-text/70 hover:border-wolf-purple/50'
                  }`}
                >
                  🔴 激进
                </button>
                <button
                  onClick={() => setAIConfig({ ...safeConfig, defaultBehavior: 'conservative' })}
                  className={`flex-1 py-3 rounded-lg border font-medium transition-all ${
                    safeConfig.defaultBehavior === 'conservative'
                      ? 'bg-blue-500/20 border-blue-500 text-blue-400'
                      : 'bg-wolf-dark/50 border-wolf-purple/30 text-wolf-text/70 hover:border-wolf-purple/50'
                  }`}
                >
                  🔵 保守
                </button>
                <button
                  onClick={() => setAIConfig({ ...safeConfig, defaultBehavior: 'random' })}
                  className={`flex-1 py-3 rounded-lg border font-medium transition-all ${
                    safeConfig.defaultBehavior === 'random'
                      ? 'bg-yellow-500/20 border-yellow-500 text-yellow-400'
                      : 'bg-wolf-dark/50 border-wolf-purple/30 text-wolf-text/70 hover:border-wolf-purple/50'
                  }`}
                >
                  🟡 随机
                </button>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-2">
                <p className="text-xs text-wolf-text/50 text-center">主动进攻，频繁怀疑</p>
                <p className="text-xs text-wolf-text/50 text-center">谨慎发言，保守判断</p>
                <p className="text-xs text-wolf-text/50 text-center">行为不可预测</p>
              </div>
            </div>
          </div>

          {aiPlayers.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Bot className="w-4 h-4 text-blue-400" />
                <h4 className="font-medium text-wolf-text">单独配置AI玩家</h4>
              </div>
              <p className="text-sm text-wolf-text/60 mb-4">
                为每个AI玩家单独配置模型和行为参数（使用当前激活的API类型）
              </p>

              <div className="space-y-4">
                {aiPlayers.map((player) => {
                  const config = player.aiConfig || {
                    model: activeConfig.model,
                    temperature: activeConfig.temperature,
                    maxTokens: activeConfig.maxTokens,
                    behavior: safeConfig.defaultBehavior,
                  };

                  return (
                    <div key={player.id} className="bg-wolf-dark/50 rounded-xl p-4 border border-wolf-purple/20">
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 bg-blue-500/20 rounded-full flex items-center justify-center">
                          <Bot className="w-4 h-4 text-blue-400" />
                        </div>
                        <span className="font-medium text-wolf-text">{player.name}</span>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                          <label className="block text-xs text-wolf-text/60 mb-1">模型</label>
                          <input
                            type="text"
                            value={config.model}
                            onChange={(e) => handlePlayerConfigChange(player.id, 'model', e.target.value)}
                            className="w-full input-field text-sm"
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-wolf-text/60 mb-1">温度: {config.temperature}</label>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.1"
                            value={config.temperature}
                            onChange={(e) => handlePlayerConfigChange(player.id, 'temperature', Number(e.target.value))}
                            className="w-full"
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-wolf-text/60 mb-1">Tokens: {config.maxTokens}</label>
                          <input
                            type="range"
                            min="200"
                            max="512"
                            step="1"
                            value={config.maxTokens}
                            onChange={(e) => handlePlayerConfigChange(player.id, 'maxTokens', Number(e.target.value))}
                            className="w-full"
                          />
                        </div>

                        <div>
                          <label className="block text-xs text-wolf-text/60 mb-1">行为</label>
                          <select
                            value={config.behavior}
                            onChange={(e) => handlePlayerConfigChange(player.id, 'behavior', e.target.value)}
                            className="w-full input-field text-sm"
                          >
                            <option value="aggressive">激进</option>
                            <option value="conservative">保守</option>
                            <option value="random">随机</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-wolf-purple/20">
            <button
              onClick={handleSave}
              className="w-full btn-primary flex items-center justify-center gap-2"
            >
              <Save className="w-4 h-4" />
              保存设置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
