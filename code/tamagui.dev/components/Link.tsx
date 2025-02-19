import type { ViewProps } from 'react-native'
import { Button, Paragraph, Text, type ButtonProps } from 'tamagui'
import { useLinkTo, type LinkProps as VXSLinkProps } from 'vxs'

export type LinkProps = ViewProps & VXSLinkProps<any>

export const Link = ({ href, replace, asChild, ...props }: LinkProps) => {
  const linkProps = useLinkTo({ href: href as string, replace })

  return (
    <Text
      tag="a"
      // always except-style
      asChild={asChild ? 'except-style' : false}
      className="t_Link"
      cursor="pointer"
      color="inherit"
      // @ts-expect-error
      fontSize="inherit"
      // @ts-expect-error
      lineHeight="inherit"
      {...props}
      {...linkProps}
    />
  )
}

export const ParagraphLink = ({
  href = '',
  replace,
  onPress,
  children,
  ...props
}: LinkProps) => {
  const linkProps = useLinkTo({ href: href as string, replace })

  return (
    <Paragraph
      tag="a"
      cursor="pointer"
      color="$color"
      hoverStyle={{ color: '$color', outlineColor: 'red' }}
      {...props}
      {...linkProps}
    >
      {children}
    </Paragraph>
  )
}

export type ButtonLinkProps = Pick<LinkProps, 'href' | 'replace' | 'target' | 'rel'> &
  ButtonProps

export const ButtonLink = ({
  href = '',
  rel,
  target,
  replace,
  children,
  ...props
}: ButtonLinkProps) => {
  return (
    <Link
      asChild
      {...{
        href,
        rel,
        target,
        replace,
      }}
    >
      <Button tag="a" {...props}>
        {children}
      </Button>
    </Link>
  )
}
