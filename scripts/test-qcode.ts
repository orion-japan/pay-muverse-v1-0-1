// scripts/test-qcode.ts
import { quickRecordQ } from '@/lib/qcode/record';

(async () => {
  const res = await quickRecordQ({
    user_code: '669933',
    text: '今日は焦りと挑戦が強め。', // => Q2に推定される想定
    intent: 'normal',
    source_type: 'muai',
  });
  console.log(res);
})();
