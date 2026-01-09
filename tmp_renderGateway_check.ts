// tmp_renderGateway_check.ts
import { renderGatewayAsReply } from './src/lib/iros/language/renderGateway';

function run(title: string, args: any) {
  const r = renderGatewayAsReply(args);
  console.log('\n===', title, '===');
  console.log('OUT:\n' + r.content);
  console.log('META:', r.meta);
}

// 1) 文中🪔が残るべきケース
run('A: inline 🪔 should stay', {
  content: '受け取った。🪔\n次は一手だけ。\n🪔',
  extra: { renderEngine: true, framePlan: { slotPlanPolicy: 'FINAL' } },
  maxLines: 8,
});

// 2) 🪔単独行は「末尾に1つ」に正規化されるべきケース
run('B: many standalone 🪔 should normalize to one at end', {
  content: '🪔\n一点だけを残す。\n🪔\n呼吸を戻す。\n🪔',
  extra: { renderEngine: true, framePlan: { slotPlanPolicy: 'FINAL' } },
  maxLines: 8,
});

// 3) SCAFFOLDでも末尾🪔が入るか（maxLines次第）
run('C: scaffold behavior', {
  content: 'writer hint: ...\nFRAME=R\n一点だけを残す。\n🪔',
  extra: { renderEngine: true, framePlan: { slotPlanPolicy: 'SCAFFOLD' } },
  maxLines: 4,
});
