// Versioned offline references. No runtime download or company-data query string.
module.exports = [
  { id:'invoice-basics', title:'数电发票官方公告', publisher:'国家税务总局', url:'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5236067/content.html', publishedOn:'2024-11-12', checkedOn:'2026-10-14', scope:'全国数电发票通用资料参考；不据此判断本企业税率或抵扣资格', guidance:'对照原件核对票号、日期、购销方和金额。票据用途、抵扣及红冲事项交由会计结合实际业务确认。' },
  { id:'invoice-operations', title:'数电发票操作指引', publisher:'国家税务总局上海市税务局', url:'https://shanghai.chinatax.gov.cn/tax/bsfw/wsbs/czsc/202412/t474475.html', publishedOn:'2024-12', checkedOn:'2026-10-14', scope:'上海操作指引，仅作流程参考；异地以所在地电子税务局当前界面为准', guidance:'查阅当地电子税务局的开票、交付与查验操作指引。软件只整理本地资料，不代开票或申报。' },
  { id:'tax-service', title:'12366纳税服务平台', publisher:'国家税务总局', url:'https://12366.chinatax.gov.cn/index.html', publishedOn:'持续更新的服务入口', checkedOn:'2026-10-14', scope:'按企业所在地、纳税人身份和实际业务咨询', guidance:'由会计核实本期申报项目、所属期和办税日期。这里不推算申报期限，不自动判定优惠资格。' }
];
