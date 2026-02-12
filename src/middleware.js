export function requireAdmin(req, res, next) {
  if (req.session?.admin?.id) return next();
  return res.redirect("/admin/login");
}

export function requireViewerOrAdmin(req, res, next) {
  if (req.session?.admin?.id) return next();
  return res.redirect("/admin/login");
}
