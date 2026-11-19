# `/help/payment` 增补「加密货币支付」文案（待小R 落地）

给 `src/app/help/payment/page.tsx` 用。**文案已定，可直接粘；不要改数字口径。**
政策依据：2026-11-19 用户决策 —— 按币退（实收数量原数退回），汇率波动由买家承担。

## 放在哪

现有六个 `<h2>` 之后（「联系客服时需要提供什么」之前）插入一节。只在 `settings.crypto === true` 时渲染，否则不显示——避免未开通的部署凭空出现加密货币说明。

## 文案（成品）

```tsx
{support.crypto && (
  <>
    <h2>用加密货币（USDT 等）付款</h2>
    <p>
      加密货币由第三方网关收款，收银台会让您自行选择链和币种。选择后才会生成收款地址；
      如果只看到「待付款」而没有地址，说明还没有选链，此时并未产生任何付款。
    </p>
    <p>
      转账金额以链上实际到账数量为准。到账后订单状态才会更新，链上确认时间可能从几分钟到几十分钟不等。
      如长时间未更新，请提供交易哈希（txid），我们据此核对。
    </p>
    <h2>加密货币订单的退款</h2>
    <p>
      网关不提供自动退款，退款由我们通过钱包人工转回您付款时使用的<strong>同一条链、同一个地址</strong>。
      退回数量按您<strong>实际到账的数量原数退回</strong>，<strong>不按人民币金额折算，汇率波动不影响退回数量</strong>。
    </p>
    <p>
      申请退款时请回信确认链与收款地址；打款完成后我们会提供交易哈希供您在链上核对。
      请注意：地址或链填错会造成无法找回的损失。
    </p>
  </>
)}
```

## 落地要求

1. **开关从哪来**：`public-support.ts` 已经在读 `settings` 那一行（`db.setting.findUnique({where:{id:1}})`），最省的改法是给它的返回值加一个字段：

   ```ts
   return {
     supportEmail: settings.supportEmail,
     sessionGuideUrl: settings.sessionGuideUrl,
     tawkSrc: tawkEmbedSrc(settings.tawk),
     cryptoEnabled: settings.crypto,   // 新增，同一行数据，不多一次查询
   }
   ```

   页面里 `const support = await publicSupport()` 后按 `support.cryptoEnabled` 条件渲染。**不要为此再查一次库。**
2. 文案里的「原数退回 / 不按人民币折算 / 汇率波动不影响数量」三句**不得改写**——这是退款争议时唯一的公示依据。
3. 不要写「原路退回」「7 天无理由」这类我们做不到或没定的表述。
4. 文案中不出现具体品牌名（下游代理商会换品牌，见 `docs/DEPLOYER-SETTINGS.md`）。

## 验收断言（@u5c0f-q 可直接用）

在 `crypto` 启用、且 `supportEmail` 已配置的实例上：

```sh
html=$(curl -s "$BASE/help/payment")
# 必须出现
echo "$html" | grep -q '原数退回'
echo "$html" | grep -q '汇率波动'
echo "$html" | grep -q '同一条链'
# 必须不出现（我们做不到 / 未承诺的表述）
! echo "$html" | grep -q '原路退回'
! echo "$html" | grep -q '尚未公布'
```

再核一次 `crypto` 关闭时该节**不渲染**（`grep -c '原数退回'` 应为 0）。

## 与客服剧本的一致性

改完请与 `docs/support-playbook.md` 3.5a 对一遍：剧本里的标准话术与页面文案必须是同一套说法，**页面是公示、剧本是口头**，两者不一致时一律以页面为准并回头改剧本。
