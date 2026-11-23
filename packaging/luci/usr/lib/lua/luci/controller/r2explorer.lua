-- LuCI 服务菜单入口：R2 Explorer 网盘
module("luci.controller.r2explorer", package.seeall)

function index()
    if not nixio.fs.access("/etc/config/r2-explorer") then
        return
    end
    local page = entry({"admin", "services", "r2explorer"}, cbi("r2explorer"), "R2 Explorer 网盘", 30)
    page.dependent = false
end
