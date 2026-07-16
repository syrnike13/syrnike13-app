/// Account-wide capabilities that are not scoped to a user, server, or channel.
#[derive(Debug, PartialEq, Eq, Copy, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "try-from-primitive", derive(num_enum::TryFromPrimitive))]
#[repr(u64)]
pub enum GlobalPermission {
    AccessAdmin = 1 << 0,
}
