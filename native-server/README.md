# Rust 原生后端

这是 FastAPI 后端的 Android/主机兼容实现：Axum + Tokio、`rusqlite` bundled SQLite，
Web 静态资源编译进二进制。业务客户端不得根据 `backend_kind` 分叉逻辑。

```bash
cargo test --locked --manifest-path native-server/Cargo.toml
cargo run --locked --manifest-path native-server/Cargo.toml -- \
  serve --db /tmp/store.db --secret-file /安全路径/token.secret \
  --bootstrap-pin-file /安全路径/bootstrap.pin --listen 127.0.0.1:8000
```

Linux 中心服务显式增加 `--backend-kind linux_native`；Android 不传该参数并继续报告
`android_native`。同一二进制仍只允许监听回环地址，公网入口交给 Caddy。

安全约束：`serve` 拒绝非回环监听；空库没有临时管理员 PIN 时拒绝启动；SQLite 启用
WAL、外键和 5 秒 busy timeout。写操作经单一连接锁串行化，读取使用独立只读连接；
条件更新与库存流水在一个事务中提交，适合本轮单门店五客户端规模。

`backup`、`inspect-backup`、`restore` 子命令处理口令加密 `.swinv.age` 文件。恢复会运行
共享迁移、校验清单和 SQLite 完整性并撤销全部旧 Token。具体切换顺序见
[`docs/DEPLOY.md`](../docs/DEPLOY.md)。
