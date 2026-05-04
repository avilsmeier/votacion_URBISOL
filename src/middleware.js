export function requireAdmin(req, res, next) {
  if (!req.session?.admin?.id) return res.redirect("/admin/login");
  if (req.session.admin.role !== "admin") return res.status(403).send("Acceso restringido a administradores.");
  return next();
}

export function requireViewerOrAdmin(req, res, next) {
  if (req.session?.admin?.id) return next();
  return res.redirect("/admin/login");
}
