// scripts/init.js
// mongosh から実行してください。
//   mongosh "<MONGODB_URI>&ssl=true&retryWrites=false" --quiet scripts/init.js
//
// 目的：各コレクションの基本インデックスを作成（重複作成は自動的にスキップされます）

(function() {
  const dbName = (process.env.MONGODB_DB || "lineai-dev");
  const dbh = db.getSiblingDB(dbName);

  function ix(col, spec, opts) {
    try {
      const r = dbh.getCollection(col).createIndex(spec, opts || {});
      print(`[index] ${col} ${JSON.stringify(spec)} name=${opts && opts.name ? opts.name : r}`);
    } catch (e) {
      // 既に存在 or 互換のため失敗しても処理継続
      print(`[index][warn] ${col} ${JSON.stringify(spec)} -> ${e.message}`);
    }
  }

  // === gpts =========================================================
  // 機能：公開検索（最新順／人気順）、コピー元→子コピー探索
  ix("gpts", { gptsId: 1 }, { name: "uniq_gptsId", unique: true });
  ix("gpts", { userId: 1, updatedAt: -1 }, { name: "idx_user_updated_desc" });
  ix("gpts", { isPublic: 1, deletedAt: 1, updatedAt: -1 }, { name: "idx_public_updated_desc" });
  ix("gpts", { isPublic: 1, deletedAt: 1, name: 1 }, { name: "idx_public_name_asc" });
  // 人気順の集計で originalGptsId -> 子コピーを素早く数えるため
  ix("gpts", { originalGptsId: 1, deletedAt: 1 }, { name: "idx_original_deleted" });

  // === user_gpts ====================================================
  // ユーザ所持リストの表示・更新時に使用
  ix("user_gpts", { userId: 1, createdAt: -1 }, { name: "idx_user_created_desc" });
  ix("user_gpts", { userId: 1, updatedAt: 1 },  { name: "idx_user_updated_asc"  });
  ix("user_gpts", { userId: 1, updatedAt: -1 }, { name: "idx_user_updated_desc" });
  // 既存運用に合わせて gptsId 単独ユニークを維持（※必要に応じて見直し）
  ix("user_gpts", { gptsId: 1 }, { name: "uniq_gptsId", unique: true });
  // 削除フラグ併用のクエリを想定するなら次も（必須ではない）
  // ix("user_gpts", { gptsId: 1, deletedAt: 1 }, { name: "idx_gptsId_deleted" });

  // === gpts_bindings ================================================
  ix("gpts_bindings", { targetType: 1, targetId: 1 }, { name: "idx_target" });
  ix("gpts_bindings", { gptsId: 1 }, { name: "idx_gptsId" });

  // === gpts_schedules ===============================================
  ix("gpts_schedules", { userId: 1, gptsId: 1 }, { name: "idx_user_gpts" });
  ix("gpts_schedules", { targetType: 1, targetId: 1 }, { name: "idx_target" });
  ix("gpts_schedules", { enabled: 1, nextRunAt: 1 }, { name: "idx_enabled_nextRunAt" });
  ix("gpts_schedules", { claimedAt: 1 }, { name: "idx_claimedAt" });
  ix("gpts_schedules", { deletedAt: 1 }, { name: "idx_deletedAt" });

  print(`[index] done for db=${dbName}`);
})();
