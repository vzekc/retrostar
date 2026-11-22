-- A password reset key valid for the given interval. Administrators send the
-- link of a new user by mail or forum message, so it lasts longer than the
-- one a member requests for themselves.
CREATE OR REPLACE FUNCTION request_password_reset(user_name VARCHAR, valid_for INTERVAL)
    RETURNS VARCHAR AS
$$
DECLARE
    new_key VARCHAR;
BEGIN
    SELECT ENCODE(GEN_RANDOM_BYTES(8), 'hex') INTO new_key;
    UPDATE "user"
    SET password_reset_key            = new_key,
        password_reset_key_expires_at = NOW() + valid_for
    WHERE name = user_name;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User % does not exist', user_name;
    END IF;
    RETURN new_key;
END;
$$
    LANGUAGE 'plpgsql';
