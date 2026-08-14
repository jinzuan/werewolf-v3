import { useState } from 'react';
import { BookOpen, Info } from 'lucide-react';
import { ROLES, ROLE_COLORS } from '../utils/roleConfig';
import type { Role } from '../types';

export const RulePanel = () => {
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);

  const roleRules: Record<Role, {
    objective: string;
    abilities: string[];
    tips: string[];
  }> = {
    wolf: {
      objective: '杀死所有好人阵营的玩家',
      abilities: [
        '每晚可以杀死一名玩家',
        '狼人之间可以在夜晚私下讨论',
        '白天需要伪装成好人',
      ],
      tips: [
        '不要过早暴露狼队友',
        '尝试引导投票到好人',
        '注意言行一致',
      ],
    },
    seer: {
      objective: '查出所有狼人并带领好人获胜',
      abilities: [
        '每晚可以查验一名玩家的身份',
        '会得知目标是狼人还是好人',
        '需要巧妙地传递信息',
      ],
      tips: [
        '初期可以隐藏身份',
        '查验到狼人时要清晰指认',
        '注意保护自己',
      ],
    },
    witch: {
      objective: '用解药和毒药帮助好人阵营',
      abilities: [
        '拥有一瓶解药和一瓶毒药',
        '解药可以救活被狼人杀死的玩家',
        '毒药可以毒死任意玩家',
        '每晚只能使用一瓶药',
      ],
      tips: [
        '第一晚通常使用解药',
        '谨慎使用毒药',
        '不要轻易暴露身份',
      ],
    },
    hunter: {
      objective: '被投票出局时带走狼人',
      abilities: [
        '被投票出局时可以开枪带走一人',
        '被女巫毒死则无法开枪',
      ],
      tips: [
        '平时可以隐藏身份',
        '被票出时带走最可疑的玩家',
        '注意分析局势',
      ],
    },
    guardian: {
      objective: '守护关键玩家帮助好人获胜',
      abilities: [
        '每晚可以守护一名玩家免受狼人袭击',
        '不能连续两晚守护同一人',
        '守卫成功后狼人不知道是守卫还是女巫救了',
      ],
      tips: [
        '保护关键神职角色',
        '混合守护避免规律',
        '守护成功时要隐藏身份',
      ],
    },
    villager: {
      objective: '通过发言找出狼人并投票处决',
      abilities: [
        '没有特殊技能',
        '只能在白天投票',
      ],
      tips: [
        '仔细观察每个玩家的发言',
        '不要被狼人的花言巧语迷惑',
        '敢于提出自己的怀疑',
      ],
    },
  };

  const gameRules = [
    {
      title: '游戏目标',
      content: '狼人阵营：杀死所有好人阵营玩家。好人阵营：投票处决所有狼人。',
    },
    {
      title: '夜晚阶段',
      content: '守卫先行动→狼人讨论投票→预言家查验→女巫用药。守卫守护成功则不死。',
    },
    {
      title: '白天阶段',
      content: '所有玩家依次发言讨论，然后投票处决一名玩家。',
    },
    {
      title: '获胜条件',
      content: '狼人：存活狼人数量≥好人数量。好人：所有狼人被处决。',
    },
  ];

  const selectedRoleInfo = selectedRole ? roleRules[selectedRole] : null;
  const selectedRoleData = selectedRole ? ROLES.find(r => r.role === selectedRole) : null;

  return (
    <div className="bg-wolf-card/50 rounded-xl border border-wolf-purple/20 overflow-hidden">
      <div className="px-4 py-3 border-b border-wolf-purple/20 bg-wolf-dark/50">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-wolf-purple" />
          <h3 className="font-semibold text-wolf-text">游戏规则</h3>
        </div>
      </div>

      <div className="p-4">
        <div className="mb-4">
          <h4 className="text-sm font-medium text-wolf-text mb-3">身份牌</h4>
          <div className="grid grid-cols-5 gap-2">
            {ROLES.map((role) => (
              <button
                key={role.role}
                onClick={() => setSelectedRole(selectedRole === role.role ? null : role.role)}
                className={`flex flex-col items-center p-2 rounded-lg transition-all ${
                  selectedRole === role.role
                    ? 'bg-wolf-purple/30 border-2 border-wolf-purple'
                    : 'bg-wolf-dark/50 border border-wolf-purple/20 hover:border-wolf-purple/40'
                }`}
              >
                <span className={`text-2xl ${selectedRole === role.role ? ROLE_COLORS[role.role] : 'text-wolf-text/70'}`}>
                  {role.icon}
                </span>
                <span className={`text-xs mt-1 ${selectedRole === role.role ? ROLE_COLORS[role.role] : 'text-wolf-text/50'}`}>
                  {role.name}
                </span>
              </button>
            ))}
          </div>
        </div>

        {selectedRoleInfo && selectedRoleData && (
          <div className="mb-4 p-3 bg-wolf-dark/50 rounded-lg border border-wolf-purple/20">
            <div className="flex items-center gap-2 mb-3">
              <span className={`text-2xl ${ROLE_COLORS[selectedRole]}`}>{selectedRoleData.icon}</span>
              <div>
                <h4 className={`font-bold ${ROLE_COLORS[selectedRole]}`}>{selectedRoleData.name}</h4>
                <p className="text-xs text-wolf-text/60">{selectedRoleData.team === 'wolf' ? '狼人阵营' : '好人阵营'}</p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <h5 className="text-xs font-medium text-wolf-text/60 mb-1">目标</h5>
                <p className="text-sm text-wolf-text">{selectedRoleInfo.objective}</p>
              </div>

              <div>
                <h5 className="text-xs font-medium text-wolf-text/60 mb-1">技能</h5>
                <ul className="space-y-1">
                  {selectedRoleInfo.abilities.map((ability, index) => (
                    <li key={index} className="text-sm text-wolf-text/80 flex items-start gap-2">
                      <span className="text-wolf-purple">•</span>
                      {ability}
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h5 className="text-xs font-medium text-wolf-text/60 mb-1">玩法提示</h5>
                <ul className="space-y-1">
                  {selectedRoleInfo.tips.map((tip, index) => (
                    <li key={index} className="text-sm text-wolf-text/80 flex items-start gap-2">
                      <span className="text-yellow-400">💡</span>
                      {tip}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div>
          <h4 className="text-sm font-medium text-wolf-text mb-3 flex items-center gap-2">
            <Info className="w-4 h-4" />
            游戏流程
          </h4>
          <div className="space-y-3">
            {gameRules.map((rule, index) => (
              <div key={index} className="p-3 bg-wolf-dark/30 rounded-lg">
                <h5 className="text-sm font-medium text-wolf-purple">{rule.title}</h5>
                <p className="text-xs text-wolf-text/70 mt-1">{rule.content}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};