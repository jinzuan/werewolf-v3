import { getRoleInfo, ROLE_COLORS, ROLES } from '../utils/roleConfig';
import type { Role } from '../types';
import { Sparkles, Target, Shield, Moon, Sun } from 'lucide-react';

interface MyRolePanelProps {
  role: Role;
}

export const MyRolePanel = ({ role }: MyRolePanelProps) => {
  const roleInfo = getRoleInfo(role);
  
  const getRoleGuide = (role: Role): string => {
    const guides: Record<Role, string> = {
      wolf: '每晚可以杀死一名玩家。与其他狼人讨论后选择目标。注意隐藏身份，白天假装好人。',
      seer: '每晚可以查验一名玩家的身份，会得知他是狼人还是好人。要巧妙地传达信息给好人阵营。',
      witch: '拥有解药和毒药各一瓶。解药可以救活被狼人杀死的玩家，毒药可以毒死任意玩家。',
      hunter: '被投票出局时可以开枪带走任意一名玩家。被女巫毒死则无法开枪。',
      guardian: '每晚可以守护一名玩家免受狼人袭击。注意不能连续两晚守护同一人。',
      villager: '没有特殊技能，只能白天投票。仔细观察发言，找出狼人并投票处决他们。',
    };
    return guides[role];
  };

  const getTeamInfo = (role: Role): { name: string; color: string; bg: string; icon: string; borderColor: string } => {
    if (role === 'wolf') {
      return { 
        name: '狼人阵营', 
        color: 'text-red-400', 
        bg: 'from-red-500/20 to-rose-500/10',
        icon: '🐺',
        borderColor: 'border-red-500/40'
      };
    }
    return { 
      name: '好人阵营', 
      color: 'text-blue-400', 
      bg: 'from-blue-500/20 to-indigo-500/10',
      icon: '👥',
      borderColor: 'border-blue-500/40'
    };
  };

  const teamInfo = getTeamInfo(role);

  return (
    <div className="card-glass p-5 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-wolf-purple/8 to-transparent" />
      
      <div className="relative z-10">
        <h3 className="font-bold text-wolf-text mb-4 flex items-center gap-3">
          <div className="relative">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-wolf-purple/35 to-wolf-purple-light/25 flex items-center justify-center border border-wolf-purple/35">
              <span className="text-sm">👤</span>
            </div>
            <div className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-wolf-purple-light rounded-full animate-pulse" />
          </div>
          <span className="text-lg">我的身份</span>
        </h3>
      
        <div className="text-center py-5 relative">
          <div className="relative inline-block mb-4">
            <div className={`absolute inset-0 blur-3xl opacity-40 ${role === 'wolf' ? 'bg-red-500/40' : 'bg-blue-500/40'} animate-pulse`} />
            <div className={`absolute inset-[-6px] blur-xl opacity-30 ${role === 'wolf' ? 'bg-red-500/30' : 'bg-blue-500/30'} rounded-full`} />
            <div className={`relative w-24 h-24 rounded-2xl flex items-center justify-center border-2 ${role === 'wolf' ? 'border-red-500/40 bg-gradient-to-br from-red-500/20 to-rose-500/10' : 'border-blue-500/40 bg-gradient-to-br from-blue-500/20 to-indigo-500/10'} animate-float-gentle`}>
              <span className={`text-6xl ${ROLE_COLORS[role]}`}>
                {roleInfo.icon}
              </span>
            </div>
          </div>
          <p className={`text-2xl font-bold ${ROLE_COLORS[role]} mb-2`}>
            {roleInfo.name}
          </p>
          <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r ${teamInfo.bg} border ${teamInfo.borderColor} animate-slide-up`}>
            <span className="text-lg">{teamInfo.icon}</span>
            <span className={`text-sm font-semibold ${teamInfo.color}`}>
              {teamInfo.name}
            </span>
            <div className={`ml-1 w-2 h-2 rounded-full ${role === 'wolf' ? 'bg-red-400' : 'bg-blue-400'} animate-pulse`} />
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div className="p-4 rounded-xl bg-gradient-to-br from-wolf-purple/5 to-wolf-purple-light/3 border border-wolf-purple/15 hover:border-wolf-purple/25 transition-all duration-300 group">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-yellow-500/35 to-amber-500/25 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                <Sparkles className="w-3.5 h-3.5 text-yellow-400" />
              </div>
              <h4 className="text-sm font-semibold text-wolf-text">角色技能</h4>
            </div>
            <p className="text-sm text-wolf-text/75 leading-relaxed pl-8">
              {roleInfo.description}
            </p>
          </div>

          <div className="p-4 rounded-xl bg-gradient-to-br from-wolf-purple/5 to-wolf-purple-light/3 border border-wolf-purple/15 hover:border-wolf-purple/25 transition-all duration-300 group">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-blue-500/35 to-indigo-500/25 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                <Target className="w-3.5 h-3.5 text-blue-400" />
              </div>
              <h4 className="text-sm font-semibold text-wolf-text">玩法提示</h4>
            </div>
            <p className="text-sm text-wolf-text/75 leading-relaxed pl-8">
              {getRoleGuide(role)}
            </p>
          </div>

          <div className="p-4 rounded-xl bg-gradient-to-br from-wolf-purple/5 to-wolf-purple-light/3 border border-wolf-purple/15">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-green-500/35 to-emerald-500/25 flex items-center justify-center">
                <Shield className="w-3.5 h-3.5 text-green-400" />
              </div>
              <h4 className="text-sm font-semibold text-wolf-text">阵营信息</h4>
            </div>
            <div className="pl-8 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {role === 'wolf' ? (
                    <Moon className="w-4 h-4 text-red-400" />
                  ) : (
                    <Sun className="w-4 h-4 text-blue-400" />
                  )}
                  <span className="text-sm text-wolf-text/60">你的阵营</span>
                </div>
                <span className={`text-sm font-medium ${teamInfo.color}`}>{teamInfo.name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-wolf-text/60">阵营目标</span>
                <span className="text-sm text-wolf-text/80">
                  {role === 'wolf' ? '杀死所有好人' : '找出并处决狼人'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
