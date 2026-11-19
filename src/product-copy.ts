export const refundSummary =
  '已确认充值失败的订单，经核实后可退回原支付方式或退回本站钱包。余额抵扣部分退回钱包；涉及钱包退款的游客需先用联系邮箱登录认领订单。退款均由支持人员处理，具体进度以订单记录为准。'

// Editorial buying guidance, not promises about model access or usage limits.
export const planBuyingAdvice: Record<string, { audience: string; consideration: string }> = {
  go: {
    audience: '适合预算有限、以日常问答和偶尔使用为主，希望先尝试付费套餐的个人用户。',
    consideration:
      '如果准备每天用 AI 写作或编程，可以先比较 Plus 的套餐内容，再决定是否需要增加预算。',
  },
  plus: {
    audience: '适合经常用 AI 学习、整理资料、写作或辅助编程，希望先建立使用习惯的个人用户。',
    consideration:
      '如果还不清楚自己的用量需求，可以先记录常用任务和使用频率；经常遇到影响工作的用量限制时，再比较 Pro 各档位。',
  },
  pro5: {
    audience: '适合已经有固定 AI 工作习惯，正在考虑从 Plus 转向 Pro 的开发者与创作者。',
    consideration:
      '先确认 Plus 是否经常无法满足实际任务，再比较 Pro 100 的套餐内容和每月价格，避免仅凭档位名称升级。',
  },
  pro20: {
    audience: '适合把 AI 用于持续开发、研究或多个项目，并能根据实际使用情况评估预算的个人用户。',
    consideration:
      '同时比较 Pro 100 与 Pro 200 的套餐内容。如果现有档位已经满足任务需求，可以继续使用，待需求明确后再升级。',
  },
  promax: {
    audience: '适合任务密集、已经了解自身用量需求，并准备为高强度工作安排更高预算的个人用户。',
    consideration:
      '先核对 Pro 500 的具体套餐内容，并与 Pro 200 比较。确认新增预算对应的服务符合需求，再检查账号和报价。',
  },
}
