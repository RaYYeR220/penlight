use anchor_lang::prelude::*;

#[error_code]
pub enum PenlightError {
    #[msg("start price must exceed a non-zero floor")]
    BadPrices,
    #[msg("clock length must be positive")]
    BadDuration,
    #[msg("lot is not in the right state for this")]
    WrongStatus,
    #[msg("account list does not match the lot")]
    BadAccounts,
    #[msg("contents do not match the commitment")]
    CommitmentMismatch,
    #[msg("clock price is above your limit")]
    PriceAboveLimit,
    #[msg("the seller cannot take their own lot")]
    SellerCannotTake,
    #[msg("only the house authority can do this")]
    NotHouseAuthority,
    #[msg("catalogue entry is malformed")]
    BadCatalogue,
    #[msg("the lot has no contents")]
    EmptyLot,
    #[msg("the clock has not reached this point yet")]
    TooEarly,
    #[msg("oracle account is not the expected feed")]
    OracleWrongFeed,
    #[msg("oracle update is not a verified republisher update")]
    OracleUnverified,
    #[msg("oracle price is stale")]
    OracleStale,
    #[msg("oracle price is out of range")]
    OracleBadValue,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("the pool cannot cover a draw")]
    PoolTooSmall,
}
