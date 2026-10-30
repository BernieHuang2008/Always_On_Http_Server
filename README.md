# Always On HTTP Server

一个小型 Flask 配置化 HTTP 服务。访问根路径会打开管理页面，API 路由会根据页面中的连线配置转发到内部逻辑。

## 运行

先在主机 Python 3.12 环境安装依赖：

```powershell
py -3.12 -m pip install -r requirements.txt
```

启动服务：

```powershell
.\scripts\run_server.ps1
```

打开：

- 管理页面：http://127.0.0.1:8787/
- 示例接口：http://127.0.0.1:8787/health
- 示例脚本接口：http://127.0.0.1:8787/echo/bernie

启动脚本会优先使用 `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`，找不到时再回退到 `py -3.12`。项目代码本身保持 Python 3.12 兼容。

## 配置

- `config.json`：长期保留的配置，重启后仍然存在。
- 临时配置：只保存在当前 Flask 进程内，重启后自动消失。
- `static_assets/`：静态文件逻辑的根目录，配置里只写相对路径。

内部逻辑支持三种类型：

- `static_page`：直接返回文本、HTML、JSON 等静态内容。
- `static_file`：返回 `static_assets/` 下的文件。
- `python_script`：执行自定义 Python 代码，代码需要定义 `handle(context)`。

Python 脚本示例：

```python
def handle(context):
    return {
        "json": {
            "method": context["method"],
            "path": context["path"],
            "query": context["query"],
            "json": context["json"],
            "path_params": context["path_params"],
        },
        "status": 200,
    }
```

## 开机自动启动

注册一个登录后自动启动的 Windows 计划任务，启动时不会打开命令行窗口：

```powershell
.\scripts\install_startup_task.ps1
```

取消自启：

```powershell
.\scripts\uninstall_startup_task.ps1
```

隐藏启动实际通过 `scripts/start_hidden.vbs` 调用主机 Python 3.12 执行 `server.py`。如果以后安装路径或 Python 版本变化，只需要调整这个 VBS 文件。

手动停止当前项目启动的服务：

```powershell
.\scripts\stop_server.ps1
```

## 安全提示

`python_script` 会执行你写入的 Python 代码，适合本机受信任场景。不要把管理页面暴露到公网，也不要运行不可信脚本。
