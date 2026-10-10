/* 共享数据库配置（Supabase）
 * 说明：anon key 是「公开密钥」，配合 RLS 策略使用，可安全放在前端；
 *       请勿把 service_role key 或任何私密令牌放进本文件。
 * 填写后，所有人访问同一网址即可共用同一份简历库数据。
 */
window.APP_CONFIG = {
  SUPABASE_URL: 'https://aqytpnzwcbqdkisnzyou.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_xfK7zu1AKOpY_15OVLx4uQ_hWqZVBWD',
  SUPABASE_BUCKET: 'resumes'
};
