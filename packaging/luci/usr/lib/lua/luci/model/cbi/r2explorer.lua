-- R2 Explorer 配置页（CBI，适配 luci-compat）
local sys = require "luci.sys"
local fs = require "nixio.fs"

m = Map("r2-explorer", "R2 文件管理", "基于 Cloudflare R2 的轻量网盘。修改配置后先点页面底部「保存&应用」，再点上方「重启服务」生效。多账号绑定请在网页端右上角「账号管理」中操作。")

local docker_ok = sys.call("command -v docker >/dev/null 2>&1") == 0
local state = ""
if docker_ok then
    state = sys.exec("docker inspect -f '{{.State.Status}}' r2-explorer 2>/dev/null"):gsub("[%s\n]+", "")
end

-- ---------- 运行状态 ----------
st = m:section(SimpleSection)
st.title = "运行状态"

o = st:option(DummyValue, "_status", "容器状态")
o.rawhtml = true
o.cfgvalue = function()
    if not docker_ok then
        return '<span style="color:red">未检测到 Docker，请先在 iStore 安装 Docker</span>'
    end
    if state == "running" then
        return '<span style="color:green">● 运行中</span>'
    elseif state ~= "" then
        return '<span style="color:orange">● ' .. state .. '</span>（请点「重启服务」）'
    end
    return '<span style="color:gray">● 未运行（点击下方「重启服务」启动）</span>'
end

o = st:option(DummyValue, "_url", "访问地址")
o.rawhtml = true
o.cfgvalue = function()
    local port = m.uci:get("r2-explorer", "main", "port") or "3000"
    local host = (luci.http.getenv("HTTP_HOST") or ""):match("^[^:]+") or "192.168.31.2"
    if state == "running" then
        return string.format('<a href="http://%s:%s/" target="_blank">打开 R2 Explorer（http://%s:%s/）</a>', host, port, host, port)
    end
    return "-"
end

o = st:option(Button, "_restart", "操作")
o.inputtitle = "重启服务"
o.description = "按下方配置重建容器（多账号数据不受影响）"
o.write = function()
    sys.call("/etc/init.d/r2-explorer restart >/dev/null 2>&1 &")
end

-- ---------- 基本配置 ----------
s = m:section(NamedSection, "main", "main", "基本配置")
s.addremove = false
s.anonymous = true

o = s:option(Flag, "enabled", "启用服务")
o.rmempty = false

o = s:option(Value, "port", "服务端口")
o.description = "映射到容器内 3000 端口；注意避开已占用端口（如 AdGuardHome 的 3000）"
o.datatype = "port"
o.rmempty = false

o = s:option(Value, "image", "Docker 镜像")
o.description = "完整版 :latest / 精简版（无 ffmpeg）:slim，或固定版本如 :v2.16.0-slim"
o.rmempty = false

o = s:option(Value, "data_dir", "数据目录")
o.description = "多账号配置（accounts.json）持久化目录"
o.rmempty = false

-- ---------- 环境变量 ----------
s2 = m:section(NamedSection, "main", "main", "环境变量")
s2.addremove = false
s2.anonymous = true

o = s2:option(Value, "auth_password", "登录密码")
o.description = "留空表示沿用现有密码；首次安装留空则自动生成随机密码（在路由器上执行 r2-explorer password 查看）"
o.password = true

o = s2:option(Value, "r2_account_id", "内置账号 Account ID（可选）")
o.description = "内置默认 R2 账号；也可不填，登录后在网页端绑定多账号"

o = s2:option(Value, "r2_access_key_id", "内置账号 Access Key ID（可选）")

o = s2:option(Value, "r2_secret_access_key", "内置账号 Secret Access Key（可选）")
o.password = true

o = s2:option(DynamicList, "extra_env", "自定义环境变量")
o.description = "每行一条 KEY=VALUE，会写入容器的 env 文件（/etc/r2-explorer/env）"

return m
