/**
 * @jest-environment node
 */

// 提取 store.js 中的 senderWeightMap 逻辑用于测试
function getSenderWeight(senderId, senderWeightMap) {
  const senderIdStr = String(senderId || '');
  if (!senderWeightMap || typeof senderWeightMap !== 'object') {
    return 1.0; // 默认不降权
  }

  // 精确匹配
  let weight = senderWeightMap[senderIdStr];
  if (weight !== undefined) {
    return weight;
  }

  // 前缀匹配
  const lowerSenderId = senderIdStr.toLowerCase();
  for (const [key, val] of Object.entries(senderWeightMap)) {
    if (lowerSenderId.startsWith(key.toLowerCase())) {
      return val;
    }
  }

  return 1.0; // 默认不降权
}

// 提取时间衰减计算逻辑用于测试
function calculateTimeDecay(createdAtMs, nowMs, timeDecayDays) {
  if (timeDecayDays <= 0 || !createdAtMs || createdAtMs <= 0) {
    return 1.0;
  }

  const ageDays = (nowMs - createdAtMs) / (1000 * 60 * 60 * 24);
  const timeWeight = Math.exp(-ageDays / timeDecayDays);
  return 0.3 + 0.7 * timeWeight;
}

describe('Store - Sender Weight Map', () => {
  describe('getSenderWeight', () => {
    test('empty map should return 1.0 (no降权)', () => {
      expect(getSenderWeight('user_1', {})).toBe(1.0);
      expect(getSenderWeight('user_1', null)).toBe(1.0);
      expect(getSenderWeight('user_1', undefined)).toBe(1.0);
    });

    test('exact match takes priority over prefix', () => {
      const map = {
        'bot_kuafu': 0.3,
        'bot_': 0.5
      };
      expect(getSenderWeight('bot_kuafu', map)).toBe(0.3);
    });

    test('prefix match (bot_*)', () => {
      const map = { 'bot_': 0.5 };
      expect(getSenderWeight('bot_kuafu', map)).toBe(0.5);
      expect(getSenderWeight('bot_assistant', map)).toBe(0.5);
      expect(getSenderWeight('bot_', map)).toBe(0.5);
    });

    test('no match should return 1.0', () => {
      const map = { 'bot_': 0.5 };
      expect(getSenderWeight('user_1', map)).toBe(1.0);
      expect(getSenderWeight('human', map)).toBe(1.0);
    });

    test('case insensitive', () => {
      const map = { 'BOT_': 0.3 };
      expect(getSenderWeight('bot_kuafu', map)).toBe(0.3);
      expect(getSenderWeight('BOT_KUAFU', map)).toBe(0.3);
      expect(getSenderWeight('Bot_Kuafu', map)).toBe(0.3);
    });

    test('multiple prefixes', () => {
      const map = {
        'system_': 0.2,
        'bot_': 0.5,
        'agent_': 0.7
      };
      expect(getSenderWeight('system_alert', map)).toBe(0.2);
      expect(getSenderWeight('bot_kuafu', map)).toBe(0.5);
      expect(getSenderWeight('agent_1', map)).toBe(0.7);
    });

    test('exact match before prefix', () => {
      const map = {
        'assistant': 0.8,
        'assistant_bot': 0.4
      };
      // assistant_bot 精确匹配 0.4
      expect(getSenderWeight('assistant_bot', map)).toBe(0.4);
      // assistant 精确匹配 0.8
      expect(getSenderWeight('assistant', map)).toBe(0.8);
    });
  });

  describe('Time Decay Calculation', () => {
    test('no decay when timeDecayDays is 0', () => {
      const now = Date.now();
      expect(calculateTimeDecay(now - 86400000, now, 0)).toBe(1.0);
    });

    test('full weight for recent messages', () => {
      const now = Date.now();
      const oneHourAgo = now - (60 * 60 * 1000);
      const result = calculateTimeDecay(oneHourAgo, now, 30);
      expect(result).toBeCloseTo(1.0, 2);
    });

    test('minimum weight (0.3) for old messages', () => {
      const now = Date.now();
      const veryOld = now - (365 * 24 * 60 * 60 * 1000); // 1 year ago
      const result = calculateTimeDecay(veryOld, now, 30);
      expect(result).toBeCloseTo(0.3, 1);
    });

    test('approximately 0.565 for 30-day-old message with 30-day decay', () => {
      const now = Date.now();
      const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
      const result = calculateTimeDecay(thirtyDaysAgo, now, 30);
      // exp(-1) ≈ 0.3679, so 0.3 + 0.7 * 0.3679 ≈ 0.5575
      expect(result).toBeCloseTo(0.5575, 1);
    });

    test('handle invalid createdAt', () => {
      const now = Date.now();
      expect(calculateTimeDecay(0, now, 30)).toBe(1.0);
      expect(calculateTimeDecay(-1, now, 30)).toBe(1.0);
      expect(calculateTimeDecay(null, now, 30)).toBe(1.0);
      expect(calculateTimeDecay(undefined, now, 30)).toBe(1.0);
    });
  });
});
