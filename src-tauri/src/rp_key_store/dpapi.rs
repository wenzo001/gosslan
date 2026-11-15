//! Windows 后端：**凭据管理器（DPAPI）**。
//!
//! ## 为什么是 DPAPI 而不是「把密钥存进凭据管理器条目」
//!
//! 两者保护强度一样（都是「当前 Windows 用户 + 当前机器」才能解），但落点不同：
//! 我们的私钥要跟着**绑定表**一起走（导出/恢复、撤销、审计），所以密钥本身仍然是
//! 一段文本 —— DPAPI 把它变成一段**只有本机能解的密文**，这段密文就存在原来那列里。
//! 这样：
//! - 不引入第二个存储（没有「库里一份、凭据管理器一份」的对不齐问题）；
//! - 导出/恢复拿到的仍是**同一列**的语义，只是内容从明文变成密文；
//! - 备份文件被拷到别的机器 ⇒ 那份密文解不开（这是**应该**的：DPAPI 本来就绑机器）。
//!
//! ## 关键参数
//!
//! - `CRYPTPROTECT_UI_FORBIDDEN`：**绝不弹 UI**。DPAPI 默认在没有用户上下文时会弹
//!   一个解锁对话框 —— 在服务/后台线程里弹框就是「应用卡住等一个人点确定」。
//!   本仓的读密钥路径可能在任何时候被触发（用户点一次授权就签一次断言），
//!   所以必须显式禁止 UI。
//! - 不设 `CRYPTPROTECT_LOCAL_MACHINE`：那个标志会让**本机任何用户**都能解密，
//!   与我们要的「只有本用户」相反。

use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

use super::KeyStoreError;

/// 用 DPAPI 加密一段字节（返回可持久化的密文 blob）。
pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, KeyStoreError> {
    // SAFETY：`pDataIn` 指向 `plaintext` 的字节（非空时长度与 `cbData` 一致），
    // `pDataOut` 指向一个可写的栈上结构体；`CryptProtectData` 只在成功时写它。
    // 三个空指针分别是「描述串 / 可选熵 / 保留位 / 提示结构」—— 都不给。
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plaintext.len() as u32,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err(KeyStoreError::Backend(format!(
                "CryptProtectData 失败（Windows 错误码 {}）",
                GetLastError()
            )));
        }
        // 成功时 `output.pbData` 指向 DPAPI 分配的内存（要用 `LocalFree` 还回去）。
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(output.pbData as *mut std::ffi::c_void);
        Ok(bytes)
    }
}

/// 解开 DPAPI 密文。
pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>, KeyStoreError> {
    // SAFETY：同 `protect` —— 输入指向 `blob`，输出结构体在栈上可写，
    // 成功后 `output.pbData` 由 DPAPI 分配、读完必须 `LocalFree`。
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: blob.len() as u32,
            pbData: blob.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err(KeyStoreError::Backend(format!(
                "CryptUnprotectData 失败（Windows 错误码 {}）—— 这份密钥不是本机当前用户封的",
                GetLastError()
            )));
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(output.pbData as *mut std::ffi::c_void);
        Ok(bytes)
    }
}
