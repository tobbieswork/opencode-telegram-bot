import assert from "node:assert/strict";
import { Service } from "@opencode/client/service";
import { OpenCodeCtl } from "../src/opencode.js";

const discover = Service.discover, ensure = Service.ensure;
let started = 0;
try {
  Service.discover = async () => undefined;
  Service.ensure = async () => { started++; throw new Error("Không được tự khởi động dịch vụ khi chỉ kiểm tra"); };
  await assert.rejects(() => new OpenCodeCtl().connect(undefined, undefined, undefined, { allowStart: false }));
  assert.equal(started, 0);
  console.log("Đạt: kết nối chỉ kiểm tra không tự tạo dịch vụ khi khám phá không có kết quả.");
} finally { Service.discover = discover; Service.ensure = ensure; }
