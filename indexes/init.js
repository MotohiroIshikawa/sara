(function(){
  function ix(c, spec, opt){ try{ db[c].createIndex(spec, opt||{}); } catch(e){ print(c, e); } }

  ix("gpts_schedules", { userId:1, gptsId:1, enabled:1, deletedAt:1, _id:-1 });
  ix("gpts_schedules", { enabled:1, nextRunAt:1 });
  ix("gpts_schedules", { targetType:1, targetId:1, enabled:1 });

  ix("gpts_bindings", { type:1, targetId:1 }, { unique:true });
  ix("gpts_bindings", { gptsId:1 });

  ix("thread_inst", { userId:1, threadId:1 }, { unique:true });
  ix("thread_inst", { userId:1 });

  ix("gpts", { gptsId:1 }, { unique:true });
  ix("gpts", { userId:1, deletedAt:1, updatedAt:-1 });

  ix("user_gpts", { userId:1, gptsId:1 }, { unique:true });
  ix("user_gpts", { userId:1 });

  ix("users", { userId:1 }, { unique:true });

  print("✔ indexes created (idempotent)");
})();