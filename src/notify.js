import nodemailer from 'nodemailer';
import { cfg } from './config.js';
import { yen, fmtDate, diffDays } from './util.js';

export async function sendDigest({ deals, coverage, routesByKey, usage, today, isFirstRun, historyAge }) {
  const subject = deals.length
    ? `✈️ 割安航空券 ${deals.length}件 (${today})`
    : `✈️ 航空券ウォッチ 稼働レポート (${today})`;

  const p = [];
  p.push('<div style="font-family:sans-serif;max-width:640px;color:#222">');
  if (isFirstRun) {
    p.push(
      `<p>初回スキャンが完了しました。価格履歴が貯まるまで (目安${cfg.detect.bootstrapDays}日) は通知が少なめです。</p>`,
    );
  }

  if (deals.length) {
    p.push('<h2 style="font-size:18px;margin:8px 0">本日の割安便 (往復・LCC除外)</h2>');
    for (const d of deals) {
      const o = d.obs;
      const label = routesByKey[d.routeKey]?.label ?? d.routeKey;
      const nights = diffDays(d.depDate, o.retDate);
      const drop = d.baseline ? Math.round((1 - o.price / d.baseline) * 100) : null;
      p.push(`
<div style="border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:10px 0">
  <div style="font-size:15px"><b>${label}</b>&nbsp;&nbsp;<b style="font-size:18px">${yen(o.price)}</b> <span style="color:#777;font-size:12px">往復</span>${drop != null ? ` <b style="color:#c0392b">▼${drop}%</b>` : ''}</div>
  <div style="margin-top:4px">${fmtDate(d.depDate)}発 → ${fmtDate(o.retDate)}帰 (${nights}泊) ・ ${o.airline} ・ ${o.transfers === 0 ? '直行' : `乗継${o.transfers}回`}</div>
  <div style="margin-top:4px;color:#555;font-size:13px">${d.reasons.map((r) => '・' + r.text).join('<br>')}</div>
  <div style="margin-top:6px">${o.link ? `<a href="${o.link}">検索結果を開く</a> ` : ''}<span style="color:#999;font-size:12px">${d.verified ? '✓ Google Flightsで実売価格を確認済み' : '※ 検索キャッシュの価格 (実際の運賃は要確認)'}</span></div>
</div>`);
    }
  } else {
    p.push('<p>本日は基準を満たす割安便はありませんでした。</p>');
  }

  p.push(
    '<h3 style="font-size:13px;color:#555;margin:20px 0 4px">データ取得状況 (今後6ヶ月の日付カバー率)</h3>',
  );
  p.push('<table style="border-collapse:collapse;font-size:12px;color:#555">');
  for (const [key, byMonth] of Object.entries(coverage)) {
    const label = routesByKey[key]?.label ?? key;
    const cells = Object.entries(byMonth)
      .map(([m, c]) => `${+m.slice(5, 7)}月 ${Math.round(c.ratio * 100)}%`)
      .join(' ・ ');
    p.push(
      `<tr><td style="padding:2px 10px 2px 0;white-space:nowrap"><b>${label}</b></td><td style="padding:2px 0">${cells}</td></tr>`,
    );
  }
  p.push('</table>');
  p.push(
    `<p style="font-size:12px;color:#999">SerpAPI (Google Flights) 使用: 本日 ${usage.todayCalls}回 / 今月 ${usage.monthCalls}回 (上限 ${cfg.serpapi.monthlyCap}) ・ 価格履歴 ${historyAge}日分</p>`,
  );
  p.push('</div>');

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: cfg.mail.user, pass: cfg.mail.pass },
  });
  await transporter.sendMail({
    from: `Flight Deal Alert <${cfg.mail.user}>`,
    to: cfg.mail.to,
    subject,
    html: p.join('\n'),
  });
  console.log(`[Mail] 送信完了: ${subject}`);
}
