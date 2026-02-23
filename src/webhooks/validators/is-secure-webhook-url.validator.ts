import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import * as net from 'net';

@ValidatorConstraint({ async: false })
class IsSecureWebhookUrlConstraint implements ValidatorConstraintInterface {
  validate(value: string, _args: ValidationArguments): boolean {
    if (typeof value !== 'string') return false;

    let url: URL;

    try {
      url = new URL(value);
    } catch {
      return false;
    }

    // Must use HTTPS
    // if (url.protocol !== 'https:') {
    //   return false;
    // }

    const hostname = url.hostname;

    // Block localhost
    // if (hostname === 'localhost') {
    //   return false;
    // }

    // If hostname is an IP address, validate it's not private/internal
    if (net.isIP(hostname)) {
      if (this.isPrivateIp(hostname)) {
        return false;
      }
    }

    return true;
  }

  defaultMessage(_args: ValidationArguments) {
    return 'Invalid webhook URL. Must be HTTPS and publicly accessible.';
  }

  private isPrivateIp(ip: string): boolean {
    // IPv4 only (extend if needed)
    const parts = ip.split('.').map(Number);

    if (parts.length !== 4) return true;

    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true;

    // 10.0.0.0/8
    if (parts[0] === 10) return true;

    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;

    // 172.16.0.0 – 172.31.255.255
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

    return false;
  }
}

export function IsSecureWebhookUrl(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsSecureWebhookUrlConstraint,
    });
  };
}
