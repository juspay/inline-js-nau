{-# LANGUAGE TemplateHaskell #-}

module Language.JavaScript.Inline.TH
  ( js,
    jsAsync,
  )
where

import Data.List
import Data.String
import Language.Haskell.TH
import Language.Haskell.TH.Quote
import Language.JavaScript.Inline.Core
import Language.JavaScript.Inline.JSParse

-- | Generate a 'JSExpr' from inline JavaScript code. The code should be a
-- single expression or a code block with potentially multiple statements (use
-- @return@ to specify the result value in which case).
--
-- Use @$var@ to refer to a Haskell variable @var@. @var@ should be an instance
-- of 'ToJS'.
js :: QuasiQuoter
js = fromQuoteExp $ inlineJS False

-- | Like 'js' but async. Top-level @await@ in the inline JavaScript code is
-- permitted.
jsAsync :: QuasiQuoter
jsAsync = fromQuoteExp $ inlineJS True

fromQuoteExp :: (String -> Q Exp) -> QuasiQuoter
fromQuoteExp q =
  QuasiQuoter
    { quoteExp = q,
      quotePat = error "Language.JavaScript.Inline.TH: quotePat",
      quoteType = error "Language.JavaScript.Inline.TH: quoteType",
      quoteDec = error "Language.JavaScript.Inline.TH: quoteDec"
    }

inlineJS :: Bool -> String -> Q Exp
inlineJS is_async js_code = do
  (is_expr, hs_vars) <-
    case jsParse js_code of
      Left err -> fail err
      Right r -> pure r
  [|
    mconcat
      $( listE
           ( [ [|
                 fromString
                   $( litE
                        ( stringL
                            ( ( if is_async
                                  then "(async ("
                                  else "(("
                              )
                                <> intercalate "," ['$' : v | v <- hs_vars]
                                <> ") => {"
                                <> ( if is_expr
                                       then "return " <> js_code <> ";"
                                       else js_code
                                   )
                                <> "})("
                            )
                        )
                    )
                 |]
             ]
               <> intersperse
                 [|fromString ","|]
                 [[|toJS $(varE (mkName v))|] | v <- hs_vars]
               <> [[|fromString ")"|]]
           )
       )
    |]
